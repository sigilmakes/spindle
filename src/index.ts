import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Repl } from "./repl.js";
import { createToolWrappers, createFileIO } from "./tools.js";
import { createDiff, retry, createContextTools, createInspectionTools } from "./builtins.js";
import { setExtensionDir, discoverAgents } from "./agents.js";
import {
    mcpList, mcpCall, mcpConnect, mcpDisconnect, mcpCleanup,
    mcpInit, mcpGetPromptSummary, mcpReload, mcpGetServers, mcpGetConnectedCount,
    type McpHandlers,
} from "./mcp.js";
import {
    subagent, killAllSubagents, cleanupWorktrees,
    type AgentResult, type SubagentOptions,
} from "./workers.js";
import {
    type SpindleExecDetails, type SpindleStatusDetails,
} from "./render.js";
import {
    WorkflowRuntime,
    discoverWorkflows,
    resolveWorkflow,
    saveWorkflow,
    parseWorkflowMeta,
    summarizeWorkflowRun,
    formatWorkflowRun,
    formatWorkflowList,
    createInMemoryAgentDriver,
    createProcessAgentDriver,
    createSnapshot,
    createSnapshotFromMeta,
    createStreamingDisplay,
    pushAgentStart,
    pushAgentEnd,
    pushPhase,
    pushLog,
    finalizeSnapshot,
    renderFleetWidget,
    FleetPanel,
    type FleetAction,
    type SpindleWorkflowDetails,
    type WorkflowRun,
    type WorkflowInput,
    type WorkflowReceipt,
    type WorkflowAgentCompletion,
    type WorkflowAgentRequest,
    type WorkflowAgentDriver,
} from "./workflow/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
setExtensionDir(__dirname);

export default function spindle(pi: ExtensionAPI) {
    const BUILTIN_NAMES = new Set([
        "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
        "Promise", "URL", "TextEncoder", "TextDecoder", "Buffer", "process", "require", "global", "globalThis",
        "read", "bash", "grep", "find", "edit", "write", "ls",
        "load", "save",
        "subagent", "thread", "threads",
        "mcp", "mcp_call", "mcp_connect", "mcp_disconnect",
        "sleep", "diff", "retry", "vars", "clear", "inspectVar", "keys", "shape", "sample", "preview", "help",
    ]);

    let repl: Repl | null = null;
    let cwd = process.cwd();
    let subModel: string | undefined;
    let agentDriverMode: "in-memory" | "process" = "in-memory";
    const cumulativeUsage = { totalCost: 0, totalSubagents: 0 };
    let currentSignal: AbortSignal | undefined;
    let widgetUi: ExtensionUIContext | null = null;
    let spindleQueue: Promise<void> = Promise.resolve();

    // Workflow engine state
    const workflowRuns = new Map<string, WorkflowRun>();
    const workflowCache = new Map<string, unknown>();
    const activeRuntimes = new Map<string, WorkflowRuntime>();

    function enqueueSpindle<T>(fn: () => Promise<T>): Promise<T> {
        const run = spindleQueue.then(fn, fn);
        spindleQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    function getAgentGuidelineLines(): string[] {
        const agents = discoverAgents(cwd);
        if (agents.length === 0) return [];
        return [
            "",
            "Available subagent types (use { agent: \"name\" } option):",
            ...agents.map((a) => {
                const meta: string[] = [a.source];
                if (a.model) meta.push(a.model);
                return `  - ${a.name}: ${a.description} (${meta.join(", ")})`;
            }),
        ];
    }

    function buildDynamicPromptSummary(workingDir: string): string {
        const sections: string[] = [];
        const agentLines = getAgentGuidelineLines();
        if (agentLines.length > 0) sections.push(agentLines.join("\n"));

        const entries = discoverWorkflows(workingDir);
        if (entries.length > 0) {
            sections.push([
                "Available Spindle workflows (call spindle({ name, args })):",
                ...entries.map((entry) => {
                    const when = entry.whenToUse ? ` — ${entry.whenToUse}` : "";
                    return `  - ${entry.name}: ${entry.description} (${entry.scope})${when}`;
                }),
            ].join("\n"));
        }

        return sections.filter(Boolean).join("\n\n");
    }

    function makeAgentDriver(workingDir: string): WorkflowAgentDriver {
        if (agentDriverMode === "process") {
            return createProcessAgentDriver({ cwd: workingDir });
        }
        return createInMemoryAgentDriver({ cwd: workingDir });
    }

    // ── Status & widget updates ──

    function updateSpindleStatus(): void {
        if (!widgetUi) return;
        const theme = widgetUi.theme;
        if (!theme) return;

        const servers = mcpGetServers();
        const connected = mcpGetConnectedCount();
        const parts: string[] = [];

        if (servers.size > 0) {
            if (connected > 0) {
                parts.push(theme.fg("success", `MCP: ${connected}/${servers.size}`));
            } else {
                parts.push(`MCP: ${servers.size} server${servers.size !== 1 ? "s" : ""}`);
            }
        }

        const runs = [...workflowRuns.values()].sort((a, b) => b.startedAt - a.startedAt);
        const active = runs.filter((r) => r.status === "running" || r.status === "queued" || r.status === "waiting");
        if (active.length > 0) {
            const agentCount = active.reduce((sum, r) => sum + r.agentOrder.length, 0);
            const agentRunning = active.reduce((sum, r) =>
                sum + r.agentOrder.filter((id) => r.agents[id]?.status === "running").length, 0);
            parts.push(theme.fg("warning", `⏣ ${agentRunning}/${agentCount}`));
        } else if (runs.length > 0) {
            parts.push(theme.fg("dim", `⏣ ${runs.length} recent`));
        }

        if (repl) {
            const vars = repl.getVariables();
            if (vars.length > 0) {
                parts.push(theme.fg("dim", `REPL: ${vars.length} var${vars.length > 1 ? "s" : ""}`));
            }
        }

        widgetUi.setStatus("spindle", parts.join(theme.fg("dim", " · ")));

        // Fleet widget: at-a-glance status above editor
        const snapshots = active.map((r) => createSnapshot(r));
        if (snapshots.length > 0) {
            const widgetLines = renderFleetWidget(snapshots, theme, { maxRuns: 5, maxAgentsPerRun: 6 });
            widgetUi.setWidget("spindle-fleet", widgetLines, { placement: "aboveEditor" });
        } else {
            widgetUi.setWidget("spindle-fleet", undefined);
        }
    }

    function initRepl(workingDir: string): Repl {
        const r = new Repl();
        cwd = workingDir;

        r.inject(createToolWrappers(cwd));

        const fileIO = createFileIO(cwd);
        r.inject({ load: fileIO.load, save: fileIO.save });

        r.inject({
            subagent: async (task: string, opts?: SubagentOptions) => {
                const result = await subagent(task, opts || {}, cwd, subModel);
                cumulativeUsage.totalCost += result.cost;
                cumulativeUsage.totalSubagents++;
                updateSpindleStatus();
                return result;
            },
            thread: async (name: string, args?: unknown) => {
                return (await launchWorkflow({ name, args }, workingDir)).result;
            },
            threads: () => [...workflowRuns.values()].sort((a, b) => b.startedAt - a.startedAt),
        });

        r.inject({
            sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
        });

        r.inject({
            mcp: mcpList,
            mcp_call: mcpCall,
            mcp_connect: mcpConnect,
            mcp_disconnect: mcpDisconnect,
        });

        r.inject({ diff: createDiff(cwd), retry });
        const ctxTools = createContextTools(r, BUILTIN_NAMES);
        const inspectTools = createInspectionTools(r);
        r.inject({
            vars: ctxTools.vars,
            clear: ctxTools.clear,
            inspectVar: inspectTools.inspectVar,
            keys: inspectTools.keys,
            shape: inspectTools.shape,
            sample: inspectTools.sample,
            preview: inspectTools.preview,
        });

        r.inject({
            help: () => [
                "=== Spindle Runtime ===",
                "",
                "Persistent JavaScript runtime with real Node environment + workflow orchestration.",
                "",
                "Workflows (call spindle tool or /spindle run <name>):",
                "  spindle({ script: `export const meta = { name, description, phases }; ...` })",
                "  spindle({ name: 'review', args: { area: 'src/' } })",
                "  Saved workflows live in .pi/threads/*.js",
                "  DSL: phase(), log(), agent(), parallel(), pipeline(), workflow()",
                "",
                "REPL builtins: read, edit, write, bash, grep, find, ls, load, save,",
                "  subagent, sleep, diff, retry, vars, clear, mcp*, help",
                "",
                "Commands: /spindle workflows, /spindle attach <id>, /spindle cleanup",
            ].join("\n"),
        });

        return r;
    }

    // ── Workflow execution ──

    async function launchWorkflow(
        input: WorkflowInput,
        workingDir: string,
        streamUpdate?: (text: string, run: WorkflowRun) => void,
        lifecycle?: {
            onAgentStart?: (e: { id: string; label: string; phase?: string; prompt: string }) => void;
            onAgentEnd?: (e: { id: string; label: string; phase?: string; result: unknown }) => void;
            onPhase?: (title: string) => void;
            onLog?: (message: string) => void;
        },
        signal?: AbortSignal,
    ): Promise<{ run: WorkflowRun; result: unknown }> {
        let script: string | undefined;
        let scriptPath: string | undefined;

        if (input.scriptPath) {
            scriptPath = path.resolve(workingDir, input.scriptPath.replace(/^@/, ""));
            script = fs.readFileSync(scriptPath, "utf-8");
        } else if (input.name) {
            const resolved = await resolveWorkflow(workingDir, input.name);
            script = resolved.script;
            scriptPath = resolved.scriptPath;
        } else if (input.script) {
            script = input.script;
        } else {
            throw new Error("spindle requires script, name, or scriptPath");
        }

        const runtime = new WorkflowRuntime({
            cwd: workingDir,
            input,
            script,
            scriptPath,
            signal,
            cache: workflowCache,
            agentDriver: makeAgentDriver(workingDir),
            resolveWorkflowScript: (nameOrPath) => resolveWorkflow(workingDir, nameOrPath),
            onUpdate: (run) => {
                workflowRuns.set(run.id, run);
                updateSpindleStatus();
                if (streamUpdate && widgetUi) {
                    streamUpdate(formatWorkflowRun(run, widgetUi.theme, false), run);
                }
            },
            onAgentStart: lifecycle?.onAgentStart,
            onAgentEnd: lifecycle?.onAgentEnd,
        });

        activeRuntimes.set(runtime.currentRun?.id ?? "pending", runtime);

        try {
            const result = await runtime.execute();
            workflowRuns.set(result.run.id, result.run);
            updateSpindleStatus();
            return result;
        } finally {
            activeRuntimes.delete(runtime.currentRun?.id ?? "pending");
        }
    }

    // ── Fleet action handler ──

    function handleFleetAction(action: FleetAction): void {
        switch (action.type) {
            case "pause": {
                const runtime = activeRuntimes.get(action.runId);
                if (runtime) {
                    runtime.cancel();
                    const run = workflowRuns.get(action.runId);
                    if (run) {
                        run.status = "paused";
                        run.updatedAt = Date.now();
                    }
                    widgetUi?.notify(`Paused workflow ${action.runId}`, "info");
                }
                break;
            }
            case "resume": {
                const run = workflowRuns.get(action.runId);
                if (run) {
                    run.status = "running";
                    run.updatedAt = Date.now();
                    widgetUi?.notify(`Resume: re-run spindle({ resumeFromRunId: "${action.runId}" }) to continue`, "info");
                }
                break;
            }
            case "stop": {
                const runtime = activeRuntimes.get(action.runId);
                if (runtime) {
                    runtime.cancel();
                }
                const run = workflowRuns.get(action.runId);
                if (run) {
                    run.status = "cancelled";
                    run.updatedAt = Date.now();
                }
                updateSpindleStatus();
                widgetUi?.notify(`Stopped workflow ${action.runId}`, "info");
                break;
            }
            case "stopAgent": {
                // Send steer message via Pi API to terminate agent
                pi.sendUserMessage(
                    `The agent ${action.agentId} should stop. Finish immediately with what you have.`,
                    { deliverAs: "steer" },
                );
                widgetUi?.notify(`Sent stop signal to agent ${action.agentId}`, "info");
                break;
            }
            case "attach": {
                // Open a message input for the agent
                widgetUi?.notify(`Use /spindle message ${action.agentId} <text> to send a message to this agent.`, "info");
                break;
            }
            case "message": {
                pi.sendUserMessage(action.text, { deliverAs: "steer" });
                widgetUi?.notify(`Message sent to agent ${action.agentId}`, "info");
                break;
            }
            case "restartAgent": {
                pi.sendUserMessage(
                    `Restart your current task from scratch. Discard previous partial results and begin again.`,
                    { deliverAs: "steer" },
                );
                widgetUi?.notify(`Sent restart signal to agent ${action.agentId}`, "info");
                break;
            }
        }
    }

    // ── Open the interactive fleet panel as overlay ──

    async function openFleetPanel(ctx: { ui: ExtensionUIContext; hasUI?: boolean }): Promise<void> {
        if (!ctx.hasUI) return;

        const runs = [...workflowRuns.values()].sort((a, b) => b.startedAt - a.startedAt);
        const theme = ctx.ui.theme;

        const result = await ctx.ui.custom<null>((tui, theme, _kb, done) => {
            const panel = new FleetPanel(theme, {
                onAction: (action) => {
                    handleFleetAction(action);
                    done(null);
                },
                onClose: () => done(null),
            });
            panel.updateRuns(runs);

            // Refresh panel data when runs change
            const refreshInterval = setInterval(() => {
                const latest = [...workflowRuns.values()].sort((a, b) => b.startedAt - a.startedAt);
                panel.updateRuns(latest);
                tui.requestRender();
            }, 2000);

            return {
                render: (w) => panel.render(w),
                invalidate: () => panel.invalidate(),
                handleInput: (data) => {
                    panel.handleInput(data);
                    tui.requestRender();
                },
                dispose: () => clearInterval(refreshInterval),
            };
        }, { overlay: true });
    }

    // ── Pi lifecycle ──

    pi.on("session_start", async (_event, ctx) => {
        repl = initRepl(ctx.cwd);
        widgetUi = ctx.ui;

        const mcpHandlers: McpHandlers = {
            onRoots: async () => ({
                roots: [{ uri: `file://${ctx.cwd}`, name: path.basename(ctx.cwd) }],
            }),
            onElicitation: async (params) => {
                if (!ctx.hasUI) return { action: "decline" as const };
                const ok = await ctx.ui.confirm("MCP Server Request", params.message);
                return { action: ok ? "accept" as const : "decline" as const };
            },
            onSampling: async (params) => {
                return {
                    model: "spindle-passthrough",
                    role: "assistant" as const,
                    content: { type: "text" as const, text: `[Sampling requested]` },
                    stopReason: "endTurn",
                };
            },
        };
        mcpInit(ctx.cwd, mcpHandlers);

        if (ctx.hasUI) {
            const servers = mcpGetServers();
            if (servers.size > 0) {
                const lines: string[] = ["[MCP Servers]"];
                for (const [name, resolved] of servers) {
                    const desc = resolved.entry.description ? ` — ${resolved.entry.description}` : "";
                    lines.push(`  ${resolved.source}: ${name}${desc}`);
                }
                ctx.ui.notify(lines.join("\n"), "info");
            }
            updateSpindleStatus();
        }

        // Restore config from session entries
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry.type === "custom" && entry.customType === "spindle-config") {
                const data = entry.data as { subModel?: string; agentDriverMode?: string } | undefined;
                if (data?.subModel !== undefined && subModel === undefined) {
                    subModel = data.subModel;
                }
                if (data?.agentDriverMode === "process" || data?.agentDriverMode === "in-memory") {
                    agentDriverMode = data.agentDriverMode;
                }
            }
        }
    });

    pi.on("before_agent_start", async (event, ctx) => {
        const sections = [mcpGetPromptSummary(), buildDynamicPromptSummary(ctx.cwd)].filter(Boolean);
        if (sections.length === 0) return;
        return { systemPrompt: event.systemPrompt + "\n\n" + sections.join("\n\n") };
    });

    pi.on("session_shutdown", async () => {
        killAllSubagents();
        widgetUi = null;
        await mcpCleanup();
        repl = null;
    });

    // ── Status helpers ──

    function buildStatusDetails(): SpindleStatusDetails {
        const variables = repl?.getVariables() ?? [];
        return {
            variables,
            usage: { ...cumulativeUsage },
            config: { subModel, outputLimit: 8192 },
        };
    }

    function formatStatusText(details: SpindleStatusDetails): string {
        const varSummary = details.variables.length > 0
            ? details.variables.map(v => `  ${v.name}: ${v.type} = ${v.preview}`).join("\n")
            : "  (none)";

        const runs = [...workflowRuns.values()];
        const active = runs.filter((r) => r.status === "running" || r.status === "queued");

        return [
            "Spindle Status",
            "",
            "Variables:",
            varSummary,
            "",
            `Usage: ${details.usage.totalSubagents} subagent calls, $${details.usage.totalCost.toFixed(4)}`,
            `Config: sub-model=${details.config.subModel || "(default)"}, driver=${agentDriverMode}`,
            `Workflows: ${runs.length} recent, ${active.length} active`,
        ].join("\n");
    }

    function formatWorkflowLibrarySummary(): string {
        const entries = discoverWorkflows(cwd);
        if (entries.length === 0) return "No saved workflows. Add .pi/threads/*.js or /spindle save <name>.";
        const lines = [`Saved workflows (${entries.length}):`];
        for (const entry of entries) {
            const phases = entry.meta.phases?.length ? ` · ${entry.meta.phases.length} phase${entry.meta.phases.length === 1 ? "" : "s"}` : "";
            lines.push(`  ${entry.name} [${entry.scope}]${phases}`);
            lines.push(`    ${entry.description}`);
            if (entry.whenToUse) lines.push(`    when: ${entry.whenToUse}`);
        }
        return lines.join("\n");
    }

    // ── Tool: spindle ──

    pi.registerTool({
        name: "spindle",
        label: "Spindle",
        description:
            "Run a Spindle workflow: scripted multi-agent orchestration with phases, parallelism, caching, structured outputs, and resume.",
        parameters: Type.Object({
            script: Type.Optional(Type.String({
                description: "Inline workflow script. Must begin with `export const meta = { ... }`.",
            })),
            name: Type.Optional(Type.String({
                description: "Saved workflow name from .pi/threads or ~/.pi/agent/threads",
            })),
            scriptPath: Type.Optional(Type.String({
                description: "Path to a workflow script file (highest priority)",
            })),
            args: Type.Optional(Type.Any({
                description: "JSON-serializable arguments exposed to the workflow as `args`",
            })),
            resumeFromRunId: Type.Optional(Type.String({
                description: "Resume from a previous run's checkpoint (same session only)",
            })),
        }),
        promptSnippet: "Run scripted multi-agent workflows with phases, parallelism, and caching",
        promptGuidelines: [
            [
                "Use spindle when coordination or multi-agent orchestration matters: phased work, parallel review, data pipelines, structured extraction, or reusable scripts.",
                "Use native tools (read, edit, write, bash) for single operations; use spindle for composed work.",
                "Call spindle with { script } for an inline workflow, { name, args } for a saved workflow, or { scriptPath, args } for a file-backed workflow.",
                "Workflow scripts must begin with `export const meta = { name, description, phases? }` as a pure literal.",
                "Workflow DSL: phase(), log(), agent(), parallel(), pipeline(), workflow(), budget, args.",
                "Use pipeline() by default for multi-stage work; use parallel() only for barrier fan-out that needs all results together.",
                "Inside parallel/pipeline, pass { phase: 'PhaseName' } to each agent() for explicit grouping — don't rely on the global phase() during concurrency.",
                "Give every agent a descriptive label: agent(prompt, { label: 'review:security' }).",
                "When a workflow agent needs to produce structured output, pass a schema: agent(prompt, { schema: { type:'object', properties:{...}, required:[...] } }).",
                "Filter parallel/pipeline results with .filter(Boolean) to handle nulls from failed agents.",
                "Saved workflows live in .pi/threads/*.js or ~/.pi/agent/threads/*.js.",
                ...getAgentGuidelineLines(),
            ].join("\n"),
        ],
        prepareArguments(args): any {
            if (!args || typeof args !== "object") return args;
            return args;
        },
        async execute(_toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
            return enqueueSpindle(async () => {
                if (!repl) repl = initRepl(ctx.cwd);
                currentSignal = signal;

                let snapshot = createSnapshotFromMeta(params.script, params.name, ctx.cwd);
                const display = createStreamingDisplay(onUpdate, ctx, snapshot);

                const streamUpdate = (text: string, run: WorkflowRun) => {
                    display.stream(text, run);
                };

                try {
                    const result = await launchWorkflow({
                        script: params.script,
                        name: params.name,
                        scriptPath: params.scriptPath,
                        args: params.args,
                        resumeFromRunId: params.resumeFromRunId,
                    }, ctx.cwd, streamUpdate, {
                        onAgentStart: (event) => {
                            snapshot = pushAgentStart(snapshot, event);
                            display.refresh(snapshot);
                        },
                        onAgentEnd: (event) => {
                            snapshot = pushAgentEnd(snapshot, event);
                            display.refresh(snapshot);
                        },
                        onPhase: (title) => {
                            snapshot = pushPhase(snapshot, title);
                            display.refresh(snapshot);
                        },
                        onLog: (message) => {
                            snapshot = pushLog(snapshot, message);
                            display.refresh(snapshot);
                        },
                    }, signal);

                    snapshot = finalizeSnapshot(snapshot, result.run);
                    display.complete(snapshot, result.run);

                    return {
                        content: [{ type: "text" as const, text: formatWorkflowRun(result.run, ctx.ui.theme, true) }],
                        details: { kind: "workflow", run: result.run } satisfies SpindleWorkflowDetails,
                    };
                } catch (err: unknown) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    const failedId = [...workflowRuns.values()].pop()?.id;
                    const failed = failedId ? workflowRuns.get(failedId) : undefined;
                    const errorText = failed
                        ? formatWorkflowRun(failed, ctx.ui.theme, true)
                        : `Workflow failed: ${error.message}`;
                    return {
                        content: [{ type: "text" as const, text: errorText }],
                        details: failed ? { kind: "workflow" as const, run: failed } satisfies SpindleWorkflowDetails : undefined,
                        isError: true,
                    };
                } finally {
                    currentSignal = undefined;
                    updateSpindleStatus();
                }
            });
        },
        renderCall(args: any, theme: any) {
            if (args.name) return new Text(`${theme.fg("toolTitle", theme.bold("spindle"))} ${theme.fg("accent", args.name)}`, 0, 0);
            if (args.scriptPath) return new Text(`${theme.fg("toolTitle", theme.bold("spindle"))} ${theme.fg("accent", args.scriptPath)}`, 0, 0);
            if (args.script) {
                const metaMatch = args.script.match(/name:\s*['"]([^'"]+)['"]/);
                const name = metaMatch?.[1] ?? "inline";
                return new Text(`${theme.fg("toolTitle", theme.bold("spindle"))} ${theme.fg("accent", name)}`, 0, 0);
            }
            return new Text(theme.fg("toolTitle", theme.bold("spindle")), 0, 0);
        },
        renderResult(result: any, options: any, theme: any) {
            return renderWorkflowResultTUI(result as AgentToolResult<SpindleWorkflowDetails>, options, theme);
        },
    });

    // ── TUI-based renderResult: uses Container/Markdown/Text ──

    function renderWorkflowResultTUI(
        result: AgentToolResult<SpindleWorkflowDetails>,
        options: { expanded: boolean; isPartial: boolean },
        theme: any,
    ) {
        const details = result.details;
        if (!details || details.kind !== "workflow" || !details.run) {
            const text = result.content?.[0];
            return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
        }

        const run = details.run;
        const mdTheme = getMarkdownTheme();
        const container = new Container();

        const { expanded, isPartial } = options;

        // Header — show running/completed status
        const statusIcon = isPartial
            ? theme.fg("warning", "◎")
            : run.status === "done"
                ? theme.fg("success", "✓")
                : run.status === "failed" || run.status === "cancelled"
                    ? theme.fg("error", "✗")
                    : theme.fg("warning", "◎");
        container.addChild(new Text(
            `${statusIcon} ${theme.fg("toolTitle", theme.bold(run.name))} ${theme.fg("dim", run.id)}`,
            0, 0,
        ));

        // Summary line — show running state for partial updates
        const done = run.agentOrder.filter((id) => {
            const s = run.agents[id]?.status;
            return s === "completed" || s === "cached";
        }).length;
        const total = run.agentOrder.length;
        const cost = run.usage.cost ? ` · $${run.usage.cost.toFixed(4)}` : "";
        const elapsed = ((run.completedAt ?? Date.now()) - run.startedAt) / 1000;
        const stateLabel = isPartial
            ? theme.fg("warning", `running · ${done}/${total}${cost} · ${elapsed.toFixed(1)}s`)
            : theme.fg("accent", `${run.status} · ${done}/${total}${cost} · ${elapsed.toFixed(1)}s`);
        container.addChild(new Text(stateLabel, 1, 0));

        // Error
        if (run.error) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(
                theme.fg("error", `⚠ ${run.error.name}: ${run.error.message}`),
                1, 0,
            ));
        }

        // Failures count
        if (run.failures.length > 0) {
            container.addChild(new Text(
                theme.fg("error", `⚠ ${run.failures.length} failure${run.failures.length === 1 ? "" : "s"}`),
                1, 0,
            ));
            if (expanded) {
                for (const f of run.failures.slice(0, 8)) {
                    container.addChild(new Text(
                        `${theme.fg("dim", f.scope)}: ${theme.fg("error", f.message)}`,
                        2, 0,
                    ));
                }
            }
        }

        // Phases
        if (run.phases.length > 0) {
            container.addChild(new Spacer(1));
            for (const phase of run.phases) {
                const pDone = phase.agents.filter((id: string) => {
                    const a = run.agents[id];
                    return a?.status === "completed" || a?.status === "cached";
                }).length;
                const pTotal = phase.agents.length;
                const phaseIcon = phase.status === "done" ? theme.fg("success", "⏣") : phase.status === "failed" ? theme.fg("error", "✦") : theme.fg("warning", "◎");
                container.addChild(new Text(
                    `${phaseIcon} ${theme.bold(phase.title)} ${theme.fg("dim", `${pDone}/${pTotal}`)}`,
                    1, 0,
                ));

                if (expanded && pTotal > 0) {
                    for (const agentId of phase.agents) {
                        const agent = run.agents[agentId];
                        if (!agent) continue;
                        const aIcon = agent.status === "completed" || agent.status === "cached"
                            ? theme.fg("success", "⏣")
                            : agent.status === "failed"
                                ? theme.fg("error", "✦")
                                : theme.fg("warning", "◎");
                        const dur = agent.durationMs ? ` ${theme.fg("dim", `${(agent.durationMs / 1000).toFixed(1)}s`)}` : "";
                        const err = agent.error ? ` ${theme.fg("error", "⚠")}` : "";
                        container.addChild(new Text(
                            `  ${aIcon} ${agent.label}${dur}${err}`,
                            2, 0,
                        ));
                    }
                }
            }
        }

        // Result — only in expanded view
        if (expanded && run.result !== undefined) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("accent", "── result ──"), 1, 0));
            const rendered = typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2);
            container.addChild(new Markdown(rendered.trim(), 1, 0, mdTheme));
        }

        return container;
    }

    // ── Slash commands ──

    pi.registerCommand("spindle", {
        description: "Spindle control — workflows, fleet panel, agents, cleanup, config",
        getArgumentCompletions: (prefix: string) => {
            const parts = prefix.trimStart().split(/\s+/);
            const first = parts[0] ?? "";
            const subcommands = [
                "workflows", "agents", "attach", "message", "stop", "pause", "resume",
                "rerun", "save", "reset", "config", "cleanup", "mcp", "status", "fleet",
            ];
            if (parts.length <= 1 && !prefix.endsWith(" ")) {
                const items = subcommands.filter((cmd) => cmd.startsWith(first)).map((cmd) => ({ value: cmd, label: cmd }));
                return items.length > 0 ? items : null;
            }
            if ((first === "run" || first === "attach" || first === "message" || first === "stop") && parts.length === 2) {
                const partial = parts[1] ?? "";
                if (first === "run") {
                    const entries = discoverWorkflows(cwd);
                    const items = entries
                        .filter((e) => e.name.startsWith(partial))
                        .map((e) => ({ value: e.name, label: e.name, description: e.description }));
                    return items.length > 0 ? items : null;
                }
                const agentIds: string[] = [];
                for (const run of [...workflowRuns.values()].sort((a, b) => b.startedAt - a.startedAt)) {
                    for (const id of run.agentOrder) {
                        if (id.startsWith(partial)) agentIds.push(id);
                    }
                }
                return agentIds.length > 0 ? agentIds.map((id) => ({ value: id, label: id })) : null;
            }
            return null;
        },
        async handler(args: string, ctx: any) {
            const parts = args.trim().split(/\s+/);
            const sub = parts[0]?.toLowerCase();

            if (sub === "workflows" || sub === "wf") {
                // Open the interactive fleet panel
                await openFleetPanel(ctx);
            } else if (sub === "fleet" || sub === "panel") {
                await openFleetPanel(ctx);
            } else if (sub === "agents") {
                const runs = [...workflowRuns.values()].sort((a, b) => b.startedAt - a.startedAt);
                const theme = ctx.ui.theme;
                const lines: string[] = ["Workflow agents:"];
                for (const run of runs.slice(0, 20)) {
                    for (const id of run.agentOrder) {
                        const agent = run.agents[id];
                        if (!agent) continue;
                        const dur = agent.durationMs ? ` ${(agent.durationMs / 1000).toFixed(1)}s` : "";
                        const phase = agent.phase ? ` [${agent.phase}]` : "";
                        lines.push(`  ${colorAgent(agent.status, theme)} ${agent.label} ${theme.fg("dim", `${run.name}${phase}${dur}`)}`);
                    }
                }
                if (lines.length === 1) lines.push(theme.fg("muted", "  No agents yet."));
                ctx.ui.notify(lines.join("\n"), "info");
            } else if (sub === "attach") {
                const agentId = parts[1];
                if (!agentId) {
                    ctx.ui.notify(`Usage: /spindle attach <agentId>`, "warning");
                    return;
                }
                let found: WorkflowRun | undefined;
                let agent: any;
                for (const run of workflowRuns.values()) {
                    const a = run.agents[agentId];
                    if (a) { found = run; agent = a; break; }
                }
                if (!found || !agent) {
                    ctx.ui.notify(`Agent ${agentId} not found. Use /spindle agents to list.`, "warning");
                    return;
                }
                const theme = ctx.ui.theme;
                const info = [
                    `${theme.fg("toolTitle", theme.bold(agent.label))} (${agentId})`,
                    `  Status: ${agent.status}`,
                    `  Run: ${found.name} (${found.id})`,
                    `  Phase: ${agent.phase ?? "(none)"}`,
                    `  ${agent.promptPreview}`,
                ].join("\n");
                ctx.ui.notify(info, "info");
                if (agent.status === "running" || agent.status === "waiting") {
                    // Send a steering message via Pi to interact with the running agent
                    ctx.ui.notify(`Use /spindle message ${agentId} <text> to inject a message into this agent.`, "info");
                }
            } else if (sub === "message") {
                const agentId = parts[1];
                const msg = parts.slice(2).join(" ").trim();
                if (!agentId || !msg) {
                    ctx.ui.notify(`Usage: /spindle message <agentId> <text>`, "warning");
                    return;
                }
                // Send a steering message to the currently-running agent via Pi
                pi.sendUserMessage(msg, { deliverAs: "steer" });
                ctx.ui.notify(`Message sent to agent ${agentId}`, "info");
            } else if (sub === "stop") {
                const target = parts[1];
                if (!target) { ctx.ui.notify("Usage: /spindle stop <runId | agentId>", "warning"); return; }
                const run = workflowRuns.get(target);
                if (run && (run.status === "running" || run.status === "queued")) {
                    const runtime = activeRuntimes.get(target);
                    if (runtime) runtime.cancel();
                    run.status = "cancelled";
                    run.updatedAt = Date.now();
                    updateSpindleStatus();
                    ctx.ui.notify(`Workflow ${run.name} (${run.id}) cancelled.`, "info");
                } else {
                    ctx.ui.notify(`No active run found for ${target}.`, "warning");
                }
            } else if (sub === "save") {
                const name = parts[1];
                if (!name) { ctx.ui.notify("Usage: /spindle save <name>", "warning"); return; }
                const template = [
                    "export const meta = {",
                    `    name: ${JSON.stringify(name)},`,
                    `    description: "Describe what ${name} coordinates.",`,
                    "    phases: [",
                    "        { title: \"Plan\", detail: \"Map the work\" },",
                    "        { title: \"Execute\", detail: \"Run the agents\" },",
                    "    ],",
                    "};",
                    "",
                    "phase(\"Plan\");",
                    "log(\"starting\", { args });",
                    "",
                    "phase(\"Execute\");",
                    "const result = await agent(`Do the work for ${meta.name}. Context: ${JSON.stringify(args)}`, { label: \"worker\" });",
                    "",
                    "return result;",
                ].join("\n");
                const script = await ctx.ui.editor(`Create workflow: ${name}`, template);
                if (!script) return;
                try {
                    parseWorkflowMeta(script);
                    const filePath = saveWorkflow(ctx.cwd, name, script, "project");
                    ctx.ui.notify(`Saved workflow: ${filePath}`, "info");
                } catch (err: unknown) {
                    const error = err instanceof Error ? err.message : String(err);
                    ctx.ui.notify(`Not saved: ${error}`, "error");
                }
            } else if (sub === "run") {
                const name = parts.slice(1).join(" ").trim();
                if (!name) { ctx.ui.notify("Usage: /spindle run <workflow-name>", "warning"); return; }
                ctx.ui.notify(`Running workflow: ${name}`, "info");
                try {
                    const result = await launchWorkflow({ name }, ctx.cwd);
                    ctx.ui.notify(formatWorkflowRun(result.run, ctx.ui.theme, true), "info");
                } catch (err: unknown) {
                    const error = err instanceof Error ? err.message : String(err);
                    ctx.ui.notify(`Workflow failed: ${error}`, "error");
                }
            } else if (sub === "reset") {
                repl?.reset();
                ctx.ui.notify("Spindle runtime reset", "info");
            } else if (sub === "config") {
                const key = parts[1]?.toLowerCase();
                const value = parts.slice(2).join(" ");
                if (key === "submodel" || key === "sub-model") {
                    subModel = value || undefined;
                    pi.appendEntry("spindle-config", { subModel, agentDriverMode });
                    ctx.ui.notify(`Sub-model set to: ${subModel || "(default)"}`, "info");
                } else if (key === "driver") {
                    if (value === "process" || value === "in-memory") {
                        agentDriverMode = value;
                        pi.appendEntry("spindle-config", { subModel, agentDriverMode });
                        ctx.ui.notify(`Agent driver set to: ${agentDriverMode}`, "info");
                    } else {
                        ctx.ui.notify(`Driver must be "process" or "in-memory". Current: ${agentDriverMode}`, "warning");
                    }
                } else {
                    ctx.ui.notify("Usage: /spindle config subModel|driver <value>", "warning");
                }
            } else if (sub === "cleanup") {
                const result = cleanupWorktrees(ctx.cwd);
                const lines: string[] = [];
                if (result.removedWorktrees.length > 0) lines.push(`Removed ${result.removedWorktrees.length} worktree(s)`);
                if (result.removedBranches.length > 0) lines.push(`Removed ${result.removedBranches.length} branch(es)`);
                if (result.removedSessions.length > 0) lines.push(`Killed ${result.removedSessions.length} tmux session(s)`);
                if (result.errors.length > 0) lines.push(`Errors: ${result.errors.join("; ")}`);
                ctx.ui.notify(lines.length === 0 ? "Nothing to clean up." : lines.join("\n"), result.errors.length > 0 ? "warning" : "info");
            } else if (sub === "mcp") {
                const mcpSub = parts[1]?.toLowerCase();
                if (mcpSub === "reload") {
                    await mcpReload(ctx.cwd);
                    const servers = mcpGetServers();
                    ctx.ui.notify(`MCP reloaded. ${servers.size} server(s).`, "info");
                } else {
                    const servers = mcpGetServers();
                    if (servers.size === 0) {
                        ctx.ui.notify("No MCP servers. Config: ~/.pi/agent/mcp.json or .pi/mcp.json", "info");
                    } else {
                        const lines = [`MCP servers (${servers.size}):`];
                        for (const [name, resolved] of servers) {
                            lines.push(`  ${name} [${resolved.source}]${resolved.entry.description ? ` — ${resolved.entry.description}` : ""}`);
                        }
                        ctx.ui.notify(lines.join("\n"), "info");
                    }
                }
            } else if (sub === "status") {
                const details = buildStatusDetails();
                ctx.ui.notify(formatStatusText(details), "info");
            } else {
                const subcommands = "workflows | fleet | agents | attach | message | stop | save | run | reset | config | cleanup | mcp | status";
                ctx.ui.notify(`Usage: /spindle <${subcommands}>`, "info");
            }
        },
    });

    function colorAgent(status: string, theme: any): string {
        const sym = status === "completed" || status === "cached" ? "✓" : status === "failed" || status === "cancelled" ? "✗" : status === "running" ? "●" : "○";
        switch (status) {
            case "completed": case "cached": return theme.fg("success", sym);
            case "failed": case "cancelled": return theme.fg("error", sym);
            case "running": return theme.fg("warning", sym);
            default: return theme.fg("muted", sym);
        }
    }
}

export { Repl } from "./repl.js";
export { createDiff, retry, createContextTools, createInspectionTools } from "./builtins.js";
export type { RetryOptions } from "./builtins.js";
export { createToolWrappers, createFileIO, load, save } from "./tools.js";
export { discoverAgents, resolveAgent, setExtensionDir, getExtensionDir } from "./agents.js";
export type { SpindleExecDetails, SpindleStatusDetails } from "./render.js";
export {
    mcpList, mcpCall, mcpConnect, mcpDisconnect, mcpCleanup,
    mcpInit, mcpGetPromptSummary, mcpReload, mcpGetServers, mcpGetConnectedCount,
} from "./mcp.js";
export type { McpHandlers } from "./mcp.js";
export { loadMcpConfig, buildServerPromptSummary } from "./mcp-config.js";
export { subagent, killAllSubagents, getActiveSubagents, getSubagent, cleanupWorktrees, readStatusFile, isTmuxPaneAlive, killTmuxSession } from "./workers.js";
export type { SubagentHandle, AgentResult, SubagentOptions, CleanupResult, StatusFile } from "./workers.js";
export { EPISODE_PROMPT, parseEpisodeBlock } from "./episode.js";
export {
    WorkflowRuntime,
    createInMemoryAgentDriver,
    createProcessAgentDriver,
    createStructuredOutputTool,
    discoverWorkflows,
    resolveWorkflow,
    saveWorkflow,
    parseWorkflowMeta,
    summarizeWorkflowRun,
    formatWorkflowRun,
    formatWorkflowList,
    FleetPanel,
    type FleetAction,
    type SpindleWorkflowDetails,
    type WorkflowRun,
    type WorkflowInput,
    type WorkflowReceipt,
    type WorkflowAgentCompletion,
    type WorkflowAgentRequest,
    type WorkflowAgentDriver,
} from "./workflow/index.js";