import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
setExtensionDir(__dirname);

export default function spindle(pi: ExtensionAPI) {
    const BUILTIN_NAMES = new Set([
        "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
        "Promise", "URL", "TextEncoder", "TextDecoder", "Buffer", "process", "require", "global", "globalThis",
        "read", "bash", "grep", "find", "edit", "write", "ls",
        "load", "save",
        "subagent",
        "mcp", "mcp_call", "mcp_connect", "mcp_disconnect",
        "sleep", "diff", "retry", "vars", "clear", "inspectVar", "keys", "shape", "sample", "preview", "help",
    ]);

    let repl: Repl | null = null;
    let cwd = process.cwd();
    let subModel: string | undefined;
    const cumulativeUsage = { totalCost: 0, totalSubagents: 0 };
    let currentSignal: AbortSignal | undefined;
    let widgetUi: ExtensionUIContext | null = null;

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
                "Automatic last-result vars after every spindle_exec call:",
                "  _last, _lastValue, _lastResult, _lastOutput, _lastFullOutput,",
                "  _lastError, _lastDurationMs, _lastStatus, _lastTruncated",
                "",
                "Commands:",
                "  /spindle reset              Reset runtime state",
                "  /spindle cleanup            Remove orphaned worktrees, branches, tmux sessions",
                "  /spindle config subModel <m> Set default subagent model",
                "  /spindle mcp                List MCP servers",
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

    pi.registerTool({
        name: "spindle_exec",
        label: "Spindle",
        description: "Execute JavaScript in a persistent Node runtime with built-in tools, sync subagents, and MCP.",
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
                "This runtime is proper Node, not a vm sandbox:",
                "  fs = require('node:fs')",
                "  path = require('node:path')",
                "  mod = await import('node:os')",
                "  console.log(process.version)",
                "",
                "If output is truncated, inspect it programmatically — the full result is still in:",
                "  _lastValue, _lastResult, _lastFullOutput",
                "  preview(_lastValue), shape(_lastValue), keys(_lastValue), sample(_lastValue)",
                "",
                "Subagents are sync by default:",
                "  r = await subagent('find all auth code')",
                "  r.findings",
                "  r = await subagent('refactor auth module', { worktree: true })",
                "  await bash({ command: `git merge ${r.branch}` })",
                "",
                "MCP (these are spindle_exec builtins — all MCP calls go through the runtime):",
                "  await mcp()                              // list servers",
                "  await mcp('server')                      // list tools on a server",
                "  r = await mcp_call('server', 'tool', {})  // one-shot call",
                "  proxy = await mcp_connect('server')       // persistent proxy",
                "  r = await proxy.toolName({args})          // camelCase method calls",
                "  await mcp_disconnect('server')            // close connection",
                "",
                "const/let/var and bare assignments persist across calls.",
                "",
                "Builtins: read, edit, write, bash, grep, find, ls, load, save,",
                "  subagent, mcp, mcp_call, mcp_connect, mcp_disconnect,",
                "  sleep, diff, retry, vars, clear, inspectVar, keys, shape,",
                "  sample, preview, help",
                ...getAgentGuidelineLines(),
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
                if (result.error) parts.push(`Error (${result.status}): ${result.error}`);
                if (result.truncated) {
                    parts.push([
                        "",
                        `Output truncated. The full result is still in REPL state: _lastValue / _lastResult / _lastFullOutput.`,
                        `Inspect it with preview(_lastValue), shape(_lastValue), keys(_lastValue), sample(_lastValue), or inspectVar('_lastResult').`,
                    ].join("\n"));
                }

                return {
                    content: [{ type: "text", text: parts.join("\n") || "(no output)" }],
                    details: {
                        code,
                        durationMs: result.durationMs,
                        error: !!result.error,
                        status: result.status,
                        truncated: result.truncated,
                    } satisfies SpindleExecDetails,
                    isError: !!result.error,
                };
            } finally {
                currentSignal = undefined;
                updateSpindleStatus();
            }
        },
        renderCall(args, theme) {
            return new Text(formatCodeForDisplay(args.code || "", theme), 0, 0);
        },
        renderResult(result, options, theme) {
            return new Text(formatExecResult(result as AgentToolResult<SpindleExecDetails>, options.expanded, theme), 0, 0);
        },
    });

    pi.registerTool({
        name: "spindle_status",
        label: "Spindle Status",
        description: "Show runtime variables, usage stats, and configuration.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            if (!repl) repl = initRepl(ctx.cwd);

            const variables = repl.getVariables();
            const details: SpindleStatusDetails = {
                variables,
                usage: { ...cumulativeUsage },
                config: { subModel, outputLimit: 8192 },
            };

            const varSummary = variables.length > 0
                ? variables.map(v => `  ${v.name}: ${v.type} = ${v.preview}`).join("\n")
                : "  (none)";

            const p = [
                "Spindle Status",
                "",
                "Variables:",
                varSummary,
                "",
                `Usage: ${cumulativeUsage.totalSubagents} subagent calls, $${cumulativeUsage.totalCost.toFixed(4)}`,
                `Config: sub-model=${subModel || "(default)"}`,
                `Last vars: _lastValue, _lastResult, _lastOutput, _lastError, _lastStatus`,
            ];

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

    pi.registerCommand("spindle", {
        description: "Spindle control — reset, config, cleanup, attach, list, mcp",
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
                ctx.ui.notify("Subagents are synchronous now. tmux is no longer the primary execution path.", "info");
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
                pi.sendUserMessage("Show Spindle status using the spindle_status tool.");
            } else if (!sub || sub === "help") {
                ctx.ui.notify("Usage: /spindle <reset|config|cleanup|mcp|status|attach|list>", "info");
            } else {
                pi.sendUserMessage(`Use Spindle (spindle_exec) for this task:\n\n${args}`);
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
