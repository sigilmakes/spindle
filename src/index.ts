import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
    formatCodeForDisplay, formatExecResult, formatStatusResult,
    type SpindleExecDetails, type SpindleStatusDetails,
} from "./render.js";
import { ThreadManager, formatThreadList, formatThreadRun, parseThreadMeta, renderThreadResult, saveThread, summarizeRun, type SpindleThreadDetails, type ThreadAgentOptions } from "./thread/index.js";

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
    const cumulativeUsage = { totalCost: 0, totalSubagents: 0 };
    let currentSignal: AbortSignal | undefined;
    let widgetUi: ExtensionUIContext | null = null;
    let threadManager: ThreadManager | null = null;

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

    function getThreadManager(workingDir: string = cwd): ThreadManager {
        if (!threadManager) {
            threadManager = new ThreadManager({
                cwd: workingDir,
                agentExecutor: async (task: string, opts?: ThreadAgentOptions) => {
                    const result = await subagent(task, opts || {}, workingDir, subModel);
                    cumulativeUsage.totalCost += result.cost;
                    cumulativeUsage.totalSubagents++;
                    updateSpindleStatus();
                    return result;
                },
                onUpdate: () => updateSpindleStatus(),
            });
        }
        threadManager.setCwd(workingDir);
        return threadManager;
    }

    function formatThreadLibrary(manager: ThreadManager): string {
        const entries = manager.discover();
        if (entries.length === 0) {
            return "No saved threads found. Add project threads in .pi/threads/*.js or use /spindle save-thread <name>.";
        }
        const lines = [`Saved threads (${entries.length}):`];
        for (const entry of entries) {
            const phases = entry.meta.phases?.length ? ` · ${entry.meta.phases.length} phase${entry.meta.phases.length === 1 ? "" : "s"}` : "";
            lines.push(`  ${entry.name} [${entry.scope}]${phases}`);
            lines.push(`    ${entry.description}`);
            if (entry.meta.whenToUse) lines.push(`    when: ${entry.meta.whenToUse}`);
        }
        return lines.join("\n");
    }

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

        if (threadManager) {
            const runs = threadManager.list();
            const active = runs.filter((run) => run.status === "running" || run.status === "queued" || run.status === "awaiting_approval");
            if (active.length > 0) {
                const agents = active.flatMap((run) => run.phases.flatMap((phase) => phase.agents));
                const done = agents.filter((agent) => agent.status === "done" || agent.status === "cached").length;
                parts.push(theme.fg("warning", `Threads: ${active.length} · ${done}/${agents.length}`));
            } else if (runs.length > 0) {
                parts.push(theme.fg("dim", `Threads: ${runs.length} recent`));
            }
        }

        if (repl) {
            const vars = repl.getVariables();
            if (vars.length > 0) {
                parts.push(theme.fg("dim", `REPL: ${vars.length} var${vars.length > 1 ? "s" : ""}`));
            }
        }

        widgetUi.setStatus("spindle", parts.join(theme.fg("dim", " · ")));
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
            thread: async (nameOrScript: string, args?: unknown) => {
                const manager = getThreadManager(cwd);
                const input = nameOrScript.includes("export const meta")
                    ? { script: nameOrScript, args }
                    : { name: nameOrScript, args };
                return (await manager.run(input)).result;
            },
            threads: () => getThreadManager(cwd).list(),
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
                "=== Spindle Node Runtime ===",
                "",
                "This is a persistent JavaScript runtime with a proper Node environment.",
                "`require`, `process`, `Buffer`, `globalThis`, and dynamic `import()` all work.",
                "",
                "Tools (return ToolResult { output, error, ok, exitCode }):",
                "  read({ path })              Read a file",
                "  edit({ path, oldText, newText })  Replace exact text",
                "  write({ path, content })    Create or overwrite",
                "  bash({ command, timeout? }) Run shell command",
                "  grep({ pattern, path })     Search with ripgrep",
                "  find({ pattern, path })     Find files by glob",
                "  ls({ path })                List directory",
                "",
                "File I/O (bypasses context window):",
                "  load(path)                  File → string, directory → Map",
                "  save(path, content)         Write without entering context",
                "",
                "Subagents (sync by default):",
                "  r = await subagent(task, opts?)   // returns AgentResult",
                "  opts: { agent, model, tools, timeout, worktree, name }",
                "  AgentResult: { status, summary, findings[], artifacts[],",
                "    blockers[], text, ok, cost, model, turns, toolCalls,",
                "    durationMs, exitCode, branch?, worktree? }",
                "",
                "Threads (scripted multi-agent orchestration):",
                "  result = await thread('name', args)       Run .pi/threads/name.js",
                "  result = await thread(`export const meta = ...`)  Run inline script",
                "  threads()                                 Recent thread runs",
                "  Thread DSL: phase(), log(), agent(), parallel(), pipeline(),",
                "    thread(), context, args, answer.done(value)",
                "",
                "MCP (servers discovered from ~/.pi/agent/mcp.json + .pi/mcp.json):",
                "  mcp()                       List MCP servers with status",
                "  mcp('server')               List tools (from cache or live)",
                "  mcp_call(server, tool, args) One-shot tool call (lazy connect)",
                "  mcp_connect(server)         Persistent proxy with camelCase methods",
                "  mcp_disconnect(server?)     Close connections",
                "",
                "Utilities:",
                "  sleep(ms), diff(a,b), retry(fn,opts?), vars(), clear(),",
                "  inspectVar(name), keys(valueOrName), shape(valueOrName),",
                "  sample(valueOrName, n?), preview(valueOrName, opts?), help()",
                "",
                "Automatic last-result vars after every spindle code call:",
                "  _last, _lastValue, _lastResult, _lastOutput, _lastFullOutput,",
                "  _lastError, _lastDurationMs, _lastStatus, _lastTruncated",
                "",
                "Commands:",
                "  /spindle reset              Reset runtime state",
                "  /spindle cleanup            Remove orphaned worktrees, branches, tmux sessions",
                "  /spindle config subModel <m> Set default subagent model",
                "  /spindle mcp                List MCP servers",
                "  /spindle threads            Inspect recent thread runs and library",
                "  /spindle run <name>         Run a saved thread from .pi/threads",
                "  /spindle mcp reload         Reload MCP config",
                "",
                "Scoping: const, let, var, and bare assignments persist across calls.",
            ].join("\n"),
        });

        return r;
    }

    pi.on("session_start", async (_event, ctx) => {
        repl = initRepl(ctx.cwd);
        widgetUi = ctx.ui;
        getThreadManager(ctx.cwd);

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
                const systemPrompt = params.systemPrompt || "";
                const lastMessage = Array.isArray(params.messages)
                    ? params.messages[params.messages.length - 1]
                    : undefined;
                const text = typeof lastMessage === "object" && lastMessage !== null
                    ? JSON.stringify(lastMessage)
                    : String(lastMessage ?? "");

                return {
                    model: "spindle-passthrough",
                    role: "assistant" as const,
                    content: {
                        type: "text" as const,
                        text: `[Sampling requested by MCP server. System: ${systemPrompt}. Last message: ${text}]`,
                    },
                    stopReason: "endTurn",
                };
            },
        };
        mcpInit(ctx.cwd, mcpHandlers);

        if (ctx.hasUI) {
            const servers = mcpGetServers();
            if (servers.size > 0) {
                const globalServers: string[] = [];
                const projectServers: string[] = [];
                const importedServers: string[] = [];

                for (const [name, resolved] of servers) {
                    const desc = resolved.entry.description ? ` — ${resolved.entry.description}` : "";
                    const line = `      ${name}${desc}`;
                    if (resolved.source === "project") projectServers.push(line);
                    else if (resolved.source === "global") globalServers.push(line);
                    else importedServers.push(line);
                }

                const lines: string[] = ["[MCP Servers]"];
                if (projectServers.length > 0) {
                    lines.push("  project", ...projectServers);
                }
                if (globalServers.length > 0) {
                    lines.push("  global", ...globalServers);
                }
                if (importedServers.length > 0) {
                    lines.push("  imported", ...importedServers);
                }
                ctx.ui.notify(lines.join("\n"), "info");
            }
            updateSpindleStatus();
        }

        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry.type === "custom" && entry.customType === "spindle-config") {
                const data = entry.data as { subModel?: string } | undefined;
                if (data?.subModel !== undefined && subModel === undefined) {
                    subModel = data.subModel;
                }
            }
        }
    });

    pi.on("before_agent_start", async (event, _ctx) => {
        const summary = mcpGetPromptSummary();
        if (!summary) return;

        return {
            systemPrompt: event.systemPrompt + "\n\n" + summary,
        };
    });

    pi.on("session_shutdown", async () => {
        killAllSubagents();
        widgetUi = null;
        await mcpCleanup();
        repl = null;
    });

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

        const manager = getThreadManager(cwd);
        const runs = manager.list();
        const active = runs.filter((run) => run.status === "running" || run.status === "queued" || run.status === "awaiting_approval");

        return [
            "Spindle Status",
            "",
            "Variables:",
            varSummary,
            "",
            `Usage: ${details.usage.totalSubagents} subagent calls, $${details.usage.totalCost.toFixed(4)}`,
            `Config: sub-model=${details.config.subModel || "(default)"}`,
            `Threads: ${runs.length} recent, ${active.length} active`,
            `Last vars: _lastValue, _lastResult, _lastOutput, _lastError, _lastStatus`,
        ].join("\n");
    }

    function codeLooksLikeThread(code: string): boolean {
        return /export\s+const\s+meta\s*=/.test(code)
            || /(^|[^.\w$])(?:phase|agent|parallel|pipeline|log)\s*\(/m.test(code)
            || /(^|[^.\w$])answer\s*\./m.test(code);
    }

    function wrapScratchThread(code: string): string {
        if (/export\s+const\s+meta\s*=/.test(code)) return code;
        return [
            "export const meta = {",
            "    name: \"scratch\",",
            "    description: \"Ad-hoc Spindle thread\",",
            "};",
            "",
            code,
        ].join("\n");
    }

    pi.registerTool({
        name: "spindle",
        label: "Spindle",
        description: "Run Spindle threads: persistent Node orchestration, programmatic subagents, phases, parallelism, caching, structured outputs, and status inspection.",
        parameters: Type.Object({
            code: Type.Optional(Type.String({ description: "JavaScript for a scratch thread. Use phase(), agent(), parallel(), pipeline(), or plain Node orchestration." })),
            name: Type.Optional(Type.String({ description: "Saved thread name from .pi/threads or ~/.pi/agent/threads" })),
            script: Type.Optional(Type.String({ description: "Inline thread script. May export `meta`; otherwise Spindle wraps it as a scratch thread." })),
            scriptPath: Type.Optional(Type.String({ description: "Path to a thread script file" })),
            args: Type.Optional(Type.Any({ description: "JSON-serializable arguments exposed to threads as args/context" })),
            inspect: Type.Optional(StringEnum(["status", "threads"] as const, {
                description: "Inspect runtime status or saved/recent threads instead of executing code",
            })),
        }),
        promptSnippet: "Run programmatic multi-agent threads with persistent Node orchestration",
        promptGuidelines: [
            [
                "Use spindle when coordination or state matters: programmatic subagents, phased work, parallel review, MCP calls, reusable scripts, caching, or structured outputs.",
                "Use native tools (read, edit, write, bash) for single straightforward operations; use spindle for composed work.",
                "Call spindle with { code } for a scratch thread, { name, args } for a saved thread, { script, args } for an inline thread, or { scriptPath, args } for a file-backed thread.",
                "Saved threads live in .pi/threads/*.js or ~/.pi/agent/threads/*.js and export `const meta = { name, description, phases }`.",
                "Thread DSL: phase(), log(), agent(), subagent(), parallel(), pipeline(), thread(), context, args, answer.done(value).",
                "Plain { code } also has real Node globals and builtins: read, edit, write, bash, grep, find, ls, load, save, subagent, thread, threads, mcp, mcp_call, mcp_connect, mcp_disconnect, sleep, diff, retry, vars, clear, inspectVar, keys, shape, sample, preview, help.",
                "If output is truncated, inspect the full value through _lastValue, _lastResult, _lastFullOutput, preview(), shape(), keys(), or sample().",
                "Use spindle with { inspect: 'threads' } to discover saved threads and recent thread runs; use { inspect: 'status' } for runtime state.",
                ...getAgentGuidelineLines(),
            ].join("\n"),
        ],
        prepareArguments(args): any {
            if (!args || typeof args !== "object") return args;
            const input = args as { action?: string; [key: string]: unknown };
            if (input.action === "status" || input.action === "threads") {
                const { action, ...rest } = input;
                return { ...rest, inspect: action };
            }
            if (input.action === "run" || input.action === "thread") {
                const { action, ...rest } = input;
                return rest;
            }
            return args;
        },
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            if (!repl) repl = initRepl(ctx.cwd);
            currentSignal = signal;
            let threadAttempt = false;

            try {
                if (params.inspect === "threads") {
                    const manager = getThreadManager(ctx.cwd);
                    const library = manager.discover();
                    const runs = manager.list();
                    const lines = [
                        formatThreadLibrary(manager),
                        "",
                        "Recent runs:",
                        runs.length === 0 ? "No threads have run yet." : runs.map(summarizeRun).join("\n"),
                    ];
                    return {
                        content: [{ type: "text" as const, text: lines.join("\n") }],
                        details: { kind: "threads", library, runs },
                    };
                }

                if (params.inspect === "status") {
                    const details = buildStatusDetails();
                    return {
                        content: [{ type: "text" as const, text: formatStatusText(details) }],
                        details: { kind: "status", ...details },
                    };
                }

                const name = params.name?.trim();
                const scriptPath = params.scriptPath?.replace(/^@/, "");
                const inlineScript = params.script;
                if (name || inlineScript || scriptPath) {
                    threadAttempt = true;
                    const manager = getThreadManager(ctx.cwd);
                    const label = name || scriptPath || "inline";
                    onUpdate?.({ content: [{ type: "text", text: `Starting thread ${label}...` }], details: undefined });
                    const result = await manager.run({
                        name,
                        script: inlineScript ? wrapScratchThread(inlineScript) : undefined,
                        scriptPath,
                        args: params.args,
                        cwd: ctx.cwd,
                    });
                    const text = [
                        `Thread ${result.run.name}: ${summarizeRun(result.run)}`,
                        result.result === undefined ? undefined : typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2),
                    ].filter(Boolean).join("\n\n");
                    return {
                        content: [{ type: "text" as const, text }],
                        details: { kind: "thread", run: result.run },
                    };
                }

                const code = params.code;
                if (!code) throw new Error("spindle requires code, name, script, scriptPath, or inspect");

                if (codeLooksLikeThread(code)) {
                    threadAttempt = true;
                    const manager = getThreadManager(ctx.cwd);
                    onUpdate?.({ content: [{ type: "text", text: "Starting scratch thread..." }], details: undefined });
                    const result = await manager.run({ script: wrapScratchThread(code), args: params.args, cwd: ctx.cwd });
                    const text = [
                        `Thread ${result.run.name}: ${summarizeRun(result.run)}`,
                        result.result === undefined ? undefined : typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2),
                    ].filter(Boolean).join("\n\n");
                    return {
                        content: [{ type: "text" as const, text }],
                        details: { kind: "thread", run: result.run },
                    };
                }

                const result = await repl.exec(code, { signal });
                const parts: string[] = [];
                if (result.output) parts.push(result.output);
                if (result.error) parts.push(`Error (${result.status}): ${result.error}`);
                if (result.truncated) {
                    parts.push([
                        "",
                        `Output truncated. The full result is still in REPL state: _lastValue / _lastResult / _lastFullOutput.`,
                        `Inspect it with preview(_lastValue), shape(_lastValue), keys(_lastValue), sample(_lastValue), or inspectVar('_lastResult').`,
                    ].join("\n"));
                }

                return {
                    content: [{ type: "text" as const, text: parts.join("\n") || "(no output)" }],
                    details: {
                        kind: "run",
                        code,
                        durationMs: result.durationMs,
                        error: !!result.error,
                        status: result.status,
                        truncated: result.truncated,
                    },
                    isError: !!result.error,
                };
            } catch (err: unknown) {
                if (threadAttempt) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    const failed = getThreadManager(ctx.cwd).list()[0];
                    return {
                        content: [{ type: "text" as const, text: `Thread failed: ${error.message}` }],
                        details: failed ? { kind: "thread", run: failed } : undefined,
                        isError: true,
                    };
                }
                throw err;
            } finally {
                currentSignal = undefined;
                updateSpindleStatus();
            }
        },
        renderCall(args, theme) {
            if (args.inspect) {
                return new Text(`${theme.fg("toolTitle", theme.bold("spindle"))} ${theme.fg("accent", `inspect ${args.inspect}`)}`, 0, 0);
            }
            if (args.name || args.scriptPath || args.script) {
                const target = args.name || args.scriptPath || "inline thread";
                return new Text(`${theme.fg("toolTitle", theme.bold("spindle"))} ${theme.fg("accent", target)}`, 0, 0);
            }
            if (args.code) return new Text(formatCodeForDisplay(args.code, theme), 0, 0);
            return new Text(theme.fg("toolTitle", theme.bold("spindle")), 0, 0);
        },
        renderResult(result, options, theme) {
            const details = result.details as ({ kind?: string } & Record<string, unknown>) | undefined;
            if (details?.kind === "run") {
                return new Text(formatExecResult(result as AgentToolResult<SpindleExecDetails>, options.expanded, theme), 0, 0);
            }
            if (details?.kind === "thread") {
                return renderThreadResult(result as AgentToolResult<SpindleThreadDetails>, options.expanded, theme);
            }
            if (details?.kind === "status") {
                return new Text(formatStatusResult(details as unknown as SpindleStatusDetails, theme), 0, 0);
            }
            if (details?.kind === "threads") {
                const runs = (details.runs ?? []) as ReturnType<ThreadManager["list"]>;
                const library = (details.library ?? []) as ReturnType<ThreadManager["discover"]>;
                const lines = [
                    library.length === 0 ? theme.fg("muted", "No saved threads found.") : theme.fg("accent", `Saved threads (${library.length})`),
                    ...library.flatMap((entry) => [`  ${theme.fg("toolTitle", entry.name)} ${theme.fg("dim", `[${entry.scope}]`)}`, `    ${theme.fg("muted", entry.description)}`]),
                    "",
                    theme.fg("accent", "Recent runs"),
                    formatThreadList(runs, theme),
                ];
                return new Text(lines.join("\n"), 0, 0);
            }
            const text = result.content[0];
            return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
        },
    });

    pi.registerCommand("spindle", {
        description: "Spindle control — reset, config, cleanup, mcp, threads, run",
        getArgumentCompletions: (prefix: string) => {
            const parts = prefix.trimStart().split(/\s+/);
            const first = parts[0] ?? "";
            if (parts.length <= 1 && !prefix.endsWith(" ")) {
                const commands = ["reset", "config", "cleanup", "mcp", "status", "threads", "run", "save-thread", "help"];
                const items = commands.filter((cmd) => cmd.startsWith(first)).map((cmd) => ({ value: cmd, label: cmd }));
                return items.length > 0 ? items : null;
            }
            if (first === "run") {
                const partial = parts[1] ?? "";
                const entries = getThreadManager(cwd).discover();
                const items = entries
                    .filter((entry) => entry.name.startsWith(partial))
                    .map((entry) => ({ value: entry.name, label: entry.name, description: entry.description }));
                return items.length > 0 ? items : null;
            }
            return null;
        },
        async handler(args, ctx) {
            const parts = args.trim().split(/\s+/);
            const sub = parts[0]?.toLowerCase();

            if (sub === "reset") {
                repl?.reset();
                ctx.ui.notify("Spindle runtime reset", "info");
            } else if (sub === "config") {
                const key = parts[1]?.toLowerCase();
                const value = parts.slice(2).join(" ");
                if (key === "submodel" || key === "sub-model") {
                    subModel = value || undefined;
                    pi.appendEntry("spindle-config", { subModel });
                    ctx.ui.notify(`Sub-model set to: ${subModel || "(default)"}`, "info");
                } else {
                    ctx.ui.notify("Usage: /spindle config subModel <value>", "warning");
                }
            } else if (sub === "attach" || sub === "list") {
                ctx.ui.notify("Subagents are synchronous now. tmux is no longer the primary execution path. Use /spindle threads for orchestration history.", "info");
            } else if (sub === "threads") {
                const manager = getThreadManager(ctx.cwd);
                const runs = manager.list();
                const theme = ctx.ui.theme;
                const sections = [
                    formatThreadLibrary(manager),
                    "",
                    "Recent runs:",
                    formatThreadList(runs, theme),
                    "",
                    "Run a saved thread with /spindle run <name> or spindle({ name }).",
                ];
                ctx.ui.notify(sections.join("\n"), "info");
            } else if (sub === "run") {
                const name = parts.slice(1).join(" ").trim();
                if (!name) {
                    ctx.ui.notify("Usage: /spindle run <thread-name>", "warning");
                } else {
                    const manager = getThreadManager(ctx.cwd);
                    ctx.ui.notify(`Running thread: ${name}`, "info");
                    try {
                        const result = await manager.run({ name, cwd: ctx.cwd });
                        ctx.ui.notify(formatThreadRun(result.run, ctx.ui.theme, true), "info");
                    } catch (err: unknown) {
                        const error = err instanceof Error ? err.message : String(err);
                        const failed = manager.list()[0];
                        ctx.ui.notify(failed ? formatThreadRun(failed, ctx.ui.theme, true) : `Thread failed: ${error}`, "error");
                    }
                }
            } else if (sub === "save-thread") {
                const name = parts.slice(1).join(" ").trim();
                if (!name) {
                    ctx.ui.notify("Usage: /spindle save-thread <name>", "warning");
                } else {
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
                        "return answer.done(result);",
                    ].join("\n");
                    const script = await ctx.ui.editor(`Create thread: ${name}`, template);
                    if (!script) return;
                    try {
                        parseThreadMeta(script);
                        const filePath = saveThread(ctx.cwd, name, script, "project");
                        ctx.ui.notify(`Saved thread: ${filePath}`, "info");
                    } catch (err: unknown) {
                        const error = err instanceof Error ? err.message : String(err);
                        ctx.ui.notify(`Thread not saved: ${error}`, "error");
                    }
                }
            } else if (sub === "mcp") {
                const mcpSub = parts[1]?.toLowerCase();
                if (mcpSub === "reload") {
                    await mcpReload(ctx.cwd);
                    const servers = mcpGetServers();
                    ctx.ui.notify(`MCP config reloaded. ${servers.size} server(s) configured.`, "info");
                } else {
                    const servers = mcpGetServers();
                    if (servers.size === 0) {
                        ctx.ui.notify("No MCP servers configured.\nConfig: ~/.pi/agent/mcp.json or .pi/mcp.json", "info");
                    } else {
                        const lines: string[] = [`MCP servers (${servers.size}):`];
                        for (const [name, resolved] of servers) {
                            let line = `  ${name} [${resolved.source}]`;
                            if (resolved.entry.description) {
                                line += ` — ${resolved.entry.description}`;
                            }
                            lines.push(line);
                        }
                        lines.push("", "Use /spindle mcp reload to refresh config.");
                        ctx.ui.notify(lines.join("\n"), "info");
                    }
                }
            } else if (sub === "cleanup" || sub === "clean") {
                const result = cleanupWorktrees(ctx.cwd);
                const lines: string[] = [];
                if (result.removedWorktrees.length > 0) {
                    lines.push(`Removed ${result.removedWorktrees.length} worktree(s): ${result.removedWorktrees.join(", ")}`);
                }
                if (result.removedBranches.length > 0) {
                    lines.push(`Removed ${result.removedBranches.length} branch(es): ${result.removedBranches.join(", ")}`);
                }
                if (result.removedSessions.length > 0) {
                    lines.push(`Killed ${result.removedSessions.length} tmux session(s): ${result.removedSessions.join(", ")}`);
                }
                if (result.errors.length > 0) {
                    lines.push(`Errors: ${result.errors.join("; ")}`);
                }
                if (lines.length === 0) {
                    lines.push("Nothing to clean up.");
                }
                ctx.ui.notify(lines.join("\n"), result.errors.length > 0 ? "warning" : "info");
            } else if (sub === "status") {
                pi.sendUserMessage("Show Spindle status using spindle with { inspect: 'status' }.");
            } else if (!sub || sub === "help") {
                ctx.ui.notify("Usage: /spindle <reset|config|cleanup|mcp|status|threads|run|save-thread>", "info");
            } else {
                pi.sendUserMessage(`Use the spindle tool for this task:\n\n${args}`);
            }
        },
    });
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
