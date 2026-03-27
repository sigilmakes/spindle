import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Repl } from "./repl.js";
import { createToolWrappers, createFileIO } from "./tools.js";
import { createDiff, retry, createContextTools } from "./builtins.js";
import { setExtensionDir } from "./agents.js";
import { mcpList, mcpCall, mcpConnect, mcpDisconnect, mcpCleanup } from "./mcp.js";
import {
    subagent, killAllSubagents, getActiveSubagents, getSubagent,
    type SubagentHandle, type AgentResult, type SubagentOptions,
} from "./workers.js";
import { startPoller, stopPoller } from "./poller.js";
import { renderDashboard } from "./dashboard.js";
import {
    formatCodeForDisplay, formatExecResult, formatStatusResult,
    type SpindleExecDetails, type SpindleStatusDetails,
} from "./render.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
setExtensionDir(__dirname);

export default function spindle(pi: ExtensionAPI) {
    const BUILTIN_NAMES = new Set([
        "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
        "Promise", "URL", "TextEncoder", "TextDecoder",
        "read", "bash", "grep", "find", "edit", "write", "ls",
        "load", "save",
        "subagent",
        "mcp", "mcp_call", "mcp_connect", "mcp_disconnect",
        "sleep", "diff", "retry", "vars", "clear", "help",
    ]);

    let repl: Repl | null = null;
    let cwd = process.cwd();
    let subModel: string | undefined;

    const cumulativeUsage = { totalCost: 0, totalSubagents: 0 };

    let currentSignal: AbortSignal | undefined;

    // Dashboard
    let setWidget: ((lines: string[] | undefined) => void) | null = null;

    function updateDashboard(): void {
        const subs = getActiveSubagents();
        if (subs.size === 0) {
            setWidget?.(undefined);
            return;
        }
        setWidget?.(renderDashboard(subs));
    }

    function initRepl(workingDir: string): Repl {
        const r = new Repl();
        cwd = workingDir;

        r.inject(createToolWrappers(cwd));

        const fileIO = createFileIO(cwd);
        r.inject({ load: fileIO.load, save: fileIO.save });

        // --- subagent() ---
        r.inject({
            subagent: (task: string, opts?: SubagentOptions) => {
                const handle = subagent(task, opts || {}, cwd, subModel);

                startPoller({
                    onUpdate: () => updateDashboard(),
                    onDone: (handle: SubagentHandle, result: AgentResult) => {
                        cumulativeUsage.totalCost += result.cost;
                        cumulativeUsage.totalSubagents++;

                        const duration = result.durationMs < 60000
                            ? `${(result.durationMs / 1000).toFixed(0)}s`
                            : `${(result.durationMs / 60000).toFixed(1)}m`;

                        const icon = result.ok ? "✓" : "✗";
                        const parts = [
                            `${icon} Subagent **${handle.id}** finished (${duration}).`,
                        ];
                        if (result.branch) parts[0] += ` Branch: \`${result.branch}\``;
                        parts.push("", `**Status:** ${result.status}`);
                        parts.push(`**Summary:** ${result.summary.slice(0, 500)}`);
                        if (result.findings.length > 0) {
                            parts.push("", "**Findings:**");
                            for (const f of result.findings) parts.push(`- ${f}`);
                        }
                        if (result.artifacts.length > 0) {
                            parts.push("", "**Artifacts:**");
                            for (const a of result.artifacts) parts.push(`- ${a}`);
                        }
                        if (result.blockers.length > 0) {
                            parts.push("", "**Blockers:**");
                            for (const b of result.blockers) parts.push(`- ${b}`);
                        }
                        parts.push("", `Cost: $${result.cost.toFixed(4)} | Turns: ${result.turns} | Tools: ${result.toolCalls}`);

                        pi.sendMessage({
                            customType: "spindle-subagent-done",
                            content: parts.join("\n"),
                            display: true,
                            details: result,
                        }, {
                            deliverAs: "followUp",
                            triggerTurn: true,
                        });

                        updateDashboard();
                    },
                });

                updateDashboard();
                return handle;
            },
        });

        r.inject({
            sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
        });

        // MCP
        r.inject({
            mcp: mcpList,
            mcp_call: mcpCall,
            mcp_connect: mcpConnect,
            mcp_disconnect: mcpDisconnect,
        });

        // Utilities
        r.inject({ diff: createDiff(cwd), retry });
        const ctxTools = createContextTools(r, BUILTIN_NAMES);
        r.inject({ vars: ctxTools.vars, clear: ctxTools.clear });

        // help()
        r.inject({
            help: () => [
                "=== Spindle REPL ===",
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
                "Subagents (async, in tmux sessions):",
                "  subagent(task, opts?)       Spawn subagent → SubagentHandle",
                "  h.status                    'running' | 'done' | 'crashed'",
                "  h.result                    Promise<AgentResult>",
                "  h.branch                    Git branch (if worktree: true)",
                "  h.cancel()                  Kill the subagent",
                "",
                "  opts: { agent, model, tools, timeout, worktree, name }",
                "  AgentResult: { status, summary, findings[], artifacts[],",
                "    blockers[], text, ok, cost, model, turns, toolCalls,",
                "    durationMs, exitCode, branch?, worktree? }",
                "",
                "MCP:",
                "  mcp()                       List MCP servers",
                "  mcp('server')               List tools for a server",
                "  mcp_call(server, tool, args) One-shot tool call",
                "  mcp_connect(server)         Persistent proxy",
                "  mcp_disconnect(server?)     Close connections",
                "",
                "Utilities:",
                "  sleep(ms), diff(a,b), retry(fn,opts?), vars(), clear(), help()",
                "",
                "Commands:",
                "  /spindle attach <id>        Open subagent's tmux session",
                "  /spindle list               Show active subagents",
                "  /spindle reset              Reset REPL state",
                "  /spindle config subModel <m> Set default subagent model",
                "",
                "Scoping: const, let, var, and bare assignments persist across calls.",
            ].join("\n"),
        });

        return r;
    }

    pi.on("session_start", async (_event, ctx) => {
        repl = initRepl(ctx.cwd);

        setWidget = (lines) => {
            try { ctx.ui.setWidget("spindle-subagents", lines as any); } catch {}
        };

        // Restore config
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i] as any;
            if (entry.customType === "spindle-config") {
                if (entry.data?.subModel !== undefined && subModel === undefined) {
                    subModel = entry.data.subModel;
                }
            }
        }
    });

    pi.on("session_shutdown", async () => {
        killAllSubagents();
        stopPoller();
        setWidget?.(undefined);
        setWidget = null;
        await mcpCleanup();
        repl = null;
    });

    // --- spindle_exec ---

    pi.registerTool({
        name: "spindle_exec",
        label: "Spindle",
        description: "Execute JavaScript in a persistent REPL with built-in tools, async subagents, and MCP.",
        parameters: Type.Object({
            code: Type.String({ description: "JavaScript code to execute" }),
        }),
        promptGuidelines: [
            [
                "Use spindle_exec when you need to chain operations, transform data, spawn subagents, or persist state.",
                "Use native tools (read, edit, write, bash) for single straightforward operations.",
                "",
                "Think in JavaScript, not bash:",
                "  ✗ bash({command: \"find src -name '*.ts' | xargs grep 'export'\"})  ← shell for data",
                "  ✓ hits = await grep({pattern: 'export class', path: 'src/'})       ← builtin + JS",
                "",
                "Subagents (async, in tmux sessions):",
                "  h = subagent('refactor auth module', { worktree: true })",
                "  // returns immediately — main agent keeps working",
                "  r = await h.result   // AgentResult with episode data",
                "  r.findings, r.artifacts, r.blockers, r.summary, r.status",
                "  await bash({ command: `git merge ${r.branch}` })",
                "",
                "  // Explore without worktree:",
                "  r = await subagent('find all auth code').result",
                "  r.findings  // what the subagent found",
                "",
                "  // From data:",
                "  files = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))",
                "  workers = files.map(f => subagent(`Review ${f}`))",
                "  results = await Promise.all(workers.map(w => w.result))",
                "",
                "const/let/var and bare assignments persist across calls.",
                "",
                "Builtins: read, edit, write, bash, grep, find, ls, load, save,",
                "  subagent, mcp, mcp_call, mcp_connect, mcp_disconnect,",
                "  sleep, diff, retry, vars, clear, help",
            ].join("\n"),
        ],

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (!repl) repl = initRepl(ctx.cwd);

            const code = params.code;
            if (!code) {
                return {
                    content: [{ type: "text", text: "Error: 'code' is required." }],
                    details: { code: "", error: true } satisfies SpindleExecDetails,
                    isError: true,
                };
            }

            currentSignal = signal;

            try {
                const result = await repl.exec(code, { signal });

                const parts: string[] = [];
                if (result.output) parts.push(result.output);
                if (result.error) parts.push(`Error: ${result.error}`);

                return {
                    content: [{ type: "text", text: parts.join("\n") || "(no output)" }],
                    details: {
                        code,
                        durationMs: result.durationMs,
                        error: !!result.error,
                    } satisfies SpindleExecDetails,
                    isError: !!result.error,
                };
            } finally {
                currentSignal = undefined;
            }
        },

        renderCall(args, theme) {
            return new Text(formatCodeForDisplay(args.code || "", theme), 0, 0);
        },

        renderResult(result, options, theme) {
            return new Text(formatExecResult(result as AgentToolResult<SpindleExecDetails>, options.expanded, theme), 0, 0);
        },
    });

    // --- spindle_status ---

    pi.registerTool({
        name: "spindle_status",
        label: "Spindle Status",
        description: "Show REPL variables, active subagents, usage stats, and configuration.",
        parameters: Type.Object({}),

        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            if (!repl) repl = initRepl(ctx.cwd);

            const variables = repl.getVariables();
            const subs = getActiveSubagents();

            const subLines: string[] = [];
            for (const [, h] of subs) {
                const elapsed = Date.now() - h.startTime;
                const dur = elapsed < 60000 ? `${(elapsed / 1000).toFixed(0)}s` : `${(elapsed / 60000).toFixed(1)}m`;
                subLines.push(`  ${h.id}: ${h.status} (${dur}) — ${h.task.slice(0, 60)}`);
            }

            const details: SpindleStatusDetails = {
                variables,
                usage: { ...cumulativeUsage },
                config: { subModel, outputLimit: 8192 },
            };

            const varSummary = variables.length > 0
                ? variables.map(v => `  ${v.name}: ${v.type} = ${v.preview}`).join("\n")
                : "  (none)";

            const p = ["Spindle Status", "", "Variables:", varSummary, ""];
            if (subLines.length > 0) {
                p.push("Subagents:", ...subLines, "");
            }
            p.push(
                `Usage: ${cumulativeUsage.totalSubagents} subagent calls, $${cumulativeUsage.totalCost.toFixed(4)}`,
                `Config: sub-model=${subModel || "(default)"}`,
            );

            return {
                content: [{ type: "text", text: p.join("\n") }],
                details,
            };
        },

        renderResult(result, _options, theme) {
            const details = result.details as SpindleStatusDetails;
            if (!details) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
            }
            return new Text(formatStatusResult(details, theme), 0, 0);
        },
    });

    // --- /spindle command ---

    pi.registerCommand("spindle", {
        description: "Spindle control — reset, config, attach to subagents, list subagents",
        async handler(args, ctx) {
            const parts = args.trim().split(/\s+/);
            const sub = parts[0]?.toLowerCase();

            if (sub === "reset") {
                repl?.reset();
                ctx.ui.notify("Spindle REPL reset", "info");
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
            } else if (sub === "attach") {
                const id = parts[1];
                if (!id) {
                    ctx.ui.notify("Usage: /spindle attach <id>", "warning");
                    return;
                }
                const handle = getSubagent(id);
                if (!handle) {
                    ctx.ui.notify(`No subagent: ${id}`, "error");
                    return;
                }
                if (process.env.TMUX) {
                    try {
                        execSync(`tmux switch-client -t ${JSON.stringify(handle.session)}`, { stdio: "pipe" });
                        ctx.ui.notify(`Switched to ${handle.session}`, "info");
                    } catch {
                        ctx.ui.notify(`Run: tmux attach -t ${handle.session}`, "info");
                    }
                } else {
                    ctx.ui.notify(`Run: tmux attach -t ${handle.session}`, "info");
                }
            } else if (sub === "list") {
                const subs = getActiveSubagents();
                if (subs.size === 0) {
                    ctx.ui.notify("No active subagents", "info");
                    return;
                }
                const lines: string[] = [];
                for (const [, h] of subs) {
                    const elapsed = Date.now() - h.startTime;
                    const dur = elapsed < 60000 ? `${(elapsed / 1000).toFixed(0)}s` : `${(elapsed / 60000).toFixed(1)}m`;
                    const resolved = (h as any).resolved;
                    const icon = resolved ? "✓" : "⏳";
                    lines.push(`${icon} ${h.id} (${dur}) tmux:${h.session}${h.branch ? ` branch:${h.branch}` : ""}`);
                    lines.push(`  ${h.task.slice(0, 80)}`);
                }
                ctx.ui.notify(lines.join("\n"), "info");
            } else if (sub === "status") {
                pi.sendUserMessage("Show Spindle status using the spindle_status tool.");
            } else if (!sub || sub === "help") {
                ctx.ui.notify("Usage: /spindle <reset|config|status|attach|list>", "info");
            } else {
                pi.sendUserMessage(`Use Spindle (spindle_exec) for this task:\n\n${args}`);
            }
        },
    });
}

// Exports
export { Repl } from "./repl.js";
export { createDiff, retry, createContextTools } from "./builtins.js";
export type { RetryOptions } from "./builtins.js";
export { createToolWrappers, createFileIO, load, save } from "./tools.js";
export { discoverAgents, resolveAgent, setExtensionDir, getExtensionDir } from "./agents.js";
export type { SpindleExecDetails, SpindleStatusDetails } from "./render.js";
export { mcpList, mcpCall, mcpConnect, mcpDisconnect, mcpCleanup } from "./mcp.js";
export { subagent, killAllSubagents, getActiveSubagents, getSubagent } from "./workers.js";
export type { SubagentHandle, AgentResult, SubagentOptions } from "./workers.js";
