import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Repl } from "./repl.js";
import { createToolWrappers, createFileIO } from "./tools.js";
import { createDiff, retry, createContextTools } from "./builtins.js";
import { setExtensionDir, discoverAgents, resolveAgent, getExtensionDir } from "./agents.js";
import { mcpList, mcpCall, mcpConnect, mcpDisconnect, mcpCleanup } from "./mcp.js";
import {
    spawn as workerSpawn, killAllWorkers, getActiveWorkers, getWorker,
    setWorkerCallbacks, resetWorkerCounter,
    type WorkerHandle, type WorkerResult, type SpawnOptions,
} from "./workers.js";
import { startPoller, stopPoller } from "./poller.js";
import { renderDashboard } from "./dashboard.js";
import {
    formatCodeForDisplay, formatExecResult, formatStatusResult,
    type SpindleExecDetails, type SpindleStatusDetails,
} from "./render.js";

// Register the extension directory so workers can find the worker extension.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
setExtensionDir(__dirname);

export default function spindle(pi: ExtensionAPI) {
    /** Names of all injected builtins — used by vars()/clear() to exclude from user variables. */
    const BUILTIN_NAMES = new Set([
        // vm context primitives
        "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
        "Promise", "URL", "TextEncoder", "TextDecoder",
        // tool wrappers
        "read", "bash", "grep", "find", "edit", "write", "ls",
        // file I/O
        "load", "save",
        // orchestration
        "spawn", "llm",
        // MCP
        "mcp", "mcp_call", "mcp_connect", "mcp_disconnect",
        // utilities
        "sleep", "diff", "retry", "vars", "clear", "help",
    ]);

    let repl: Repl | null = null;
    let cwd = process.cwd();
    let subModel: string | undefined;
    let sessionFile: string | undefined;

    const cumulativeUsage = { totalCost: 0, totalLlmCalls: 0 };

    // Per-exec state
    let currentOnUpdate: AgentToolUpdateCallback<SpindleExecDetails> | undefined;
    let currentSignal: AbortSignal | undefined;
    let currentCode = "";

    // Dashboard management
    let dashboardVisible = false;

    function updateDashboard(): void {
        const workers = getActiveWorkers();
        if (workers.size === 0) {
            if (dashboardVisible) {
                try {
                    // Clear widget after brief delay so user sees final state
                    setTimeout(() => {
                        const current = getActiveWorkers();
                        const allDone = [...current.values()].every((h: any) => h.resolved);
                        if (allDone && dashboardVisible) {
                            // Keep showing for a bit then clear
                        }
                    }, 3000);
                } catch { /* ignore */ }
            }
            return;
        }
        const lines = renderDashboard(workers);
        if (lines.length > 0) {
            try {
                (globalThis as any).__spindle_setWidget?.(lines);
            } catch { /* pi might be shutting down */ }
            dashboardVisible = true;
        }
    }

    function clearDashboard(): void {
        try {
            (globalThis as any).__spindle_clearWidget?.();
        } catch { /* ignore */ }
        dashboardVisible = false;
    }

    function initRepl(workingDir: string): Repl {
        const r = new Repl();
        cwd = workingDir;

        r.inject(createToolWrappers(cwd));

        const fileIO = createFileIO(cwd);
        r.inject({ load: fileIO.load, save: fileIO.save });

        // --- spawn() — async worker in tmux session ---
        r.inject({
            spawn: (task: string, opts?: SpawnOptions) => {
                const handle = workerSpawn(task, opts || {}, cwd, subModel);

                // Start the poller if not already running
                startPoller({
                    onUpdate: () => updateDashboard(),
                    onWorkerDone: (handle: WorkerHandle, result: WorkerResult) => {
                        cumulativeUsage.totalCost += result.cost;
                        cumulativeUsage.totalLlmCalls++;

                        const duration = result.durationMs < 60000
                            ? `${(result.durationMs / 1000).toFixed(0)}s`
                            : `${(result.durationMs / 60000).toFixed(1)}m`;

                        const icon = result.status === "success" ? "✓" : "✗";

                        // Build structured content for the agent
                        const parts = [
                            `${icon} Worker **${handle.id}** finished (${duration}). Branch: \`${handle.branch}\``,
                            "",
                            `**Status:** ${result.status}`,
                            `**Summary:** ${result.summary.slice(0, 500)}`,
                        ];
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
                            customType: "spindle-worker-done",
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

        // --- llm() — blocking one-shot subagent (no tmux, no worktree) ---
        r.inject({
            llm: async (prompt: string, opts?: {
                agent?: string; model?: string; tools?: string[];
                timeout?: number; maxOutput?: number | false;
            }) => {
                const agents = discoverAgents(cwd);
                const agentConfig = opts?.agent ? resolveAgent(agents, opts.agent) : undefined;

                const args: string[] = ["--mode", "json", "-p", "--no-session"];

                const model = opts?.model ?? agentConfig?.model ?? subModel;
                if (model) args.push("--model", model);

                const tools = opts?.tools ?? agentConfig?.tools;
                if (tools?.length) args.push("--tools", tools.join(","));

                // System prompt
                let tmpDir: string | null = null;
                let tmpFile: string | null = null;
                if (agentConfig?.systemPrompt?.trim()) {
                    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-llm-"));
                    tmpFile = path.join(tmpDir, "prompt.md");
                    fs.writeFileSync(tmpFile, agentConfig.systemPrompt, { encoding: "utf-8", mode: 0o600 });
                    args.push("--append-system-prompt", tmpFile);
                }

                args.push(`Task: ${prompt}`);

                const result = await new Promise<{
                    text: string; cost: number; model: string;
                    turns: number; exitCode: number; error?: string;
                }>((resolve) => {
                    const proc = nodeSpawn("pi", args, {
                        cwd,
                        shell: false,
                        stdio: ["ignore", "pipe", "pipe"],
                    });

                    let buffer = "";
                    let stderr = "";
                    let lastText = "";
                    let totalCost = 0;
                    let processModel = "";
                    let turns = 0;
                    let errorMessage: string | undefined;

                    const processLine = (line: string) => {
                        if (!line.trim()) return;
                        let event: Record<string, unknown>;
                        try { event = JSON.parse(line); } catch { return; }

                        if (event.type === "message_end" && event.message) {
                            const msg = event.message as Message;
                            if (msg.role === "assistant") {
                                turns++;
                                const u = msg.usage as any;
                                if (u) totalCost += u.cost?.total || 0;
                                if (!processModel && msg.model) processModel = msg.model as string;
                                if ((msg as any).errorMessage) errorMessage = (msg as any).errorMessage;
                                for (const part of msg.content) {
                                    if (part.type === "text") lastText = part.text;
                                }
                            }
                        }
                    };

                    proc.stdout!.on("data", (data: Buffer) => {
                        buffer += data.toString();
                        const lines = buffer.split("\n");
                        buffer = lines.pop() || "";
                        for (const line of lines) processLine(line);
                    });

                    proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

                    proc.on("close", (code) => {
                        if (buffer.trim()) processLine(buffer);
                        resolve({
                            text: lastText,
                            cost: totalCost,
                            model: processModel || "unknown",
                            turns,
                            exitCode: code ?? 1,
                            error: errorMessage || (code !== 0 ? stderr : undefined),
                        });
                    });

                    proc.on("error", () => {
                        resolve({ text: "", cost: 0, model: "unknown", turns: 0, exitCode: 1, error: "Failed to spawn pi" });
                    });

                    if (opts?.timeout) {
                        setTimeout(() => {
                            if (!proc.killed) {
                                proc.kill("SIGTERM");
                                setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
                            }
                        }, opts.timeout);
                    }

                    if (currentSignal) {
                        const signal = currentSignal;
                        const kill = () => {
                            proc.kill("SIGTERM");
                            setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
                        };
                        if (signal.aborted) kill();
                        else signal.addEventListener("abort", kill, { once: true });
                    }
                });

                // Cleanup temp files
                if (tmpFile) try { fs.unlinkSync(tmpFile); } catch {}
                if (tmpDir) try { fs.rmdirSync(tmpDir); } catch {}

                cumulativeUsage.totalCost += result.cost;
                cumulativeUsage.totalLlmCalls++;

                // Apply maxOutput truncation
                let text = result.text;
                const max = opts?.maxOutput;
                if (max !== undefined && max !== false && Number.isFinite(max) && text.length > max) {
                    const limit = Math.max(max, 1024);
                    const headSize = Math.floor(limit * 0.7);
                    const tailSize = limit - headSize;
                    text = text.slice(0, headSize) +
                        `\n\n... [truncated: ${text.length} total chars] ...\n\n` +
                        text.slice(-tailSize);
                }

                return {
                    text,
                    cost: result.cost,
                    model: result.model,
                    turns: result.turns,
                    exitCode: result.exitCode,
                    error: result.error,
                    ok: result.exitCode === 0,
                };
            },
        });

        r.inject({
            sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
        });

        // --- MCP builtins ---
        r.inject({
            mcp: mcpList,
            mcp_call: mcpCall,
            mcp_connect: mcpConnect,
            mcp_disconnect: mcpDisconnect,
        });

        // --- Utility builtins: diff, retry, vars, clear ---
        r.inject({ diff: createDiff(cwd), retry });

        const ctxTools = createContextTools(r, BUILTIN_NAMES);
        r.inject({ vars: ctxTools.vars, clear: ctxTools.clear });

        // --- help() ---
        r.inject({
            help: () => [
                "=== Spindle REPL ===",
                "",
                "Tools (return ToolResult { output, error, ok, exitCode }):",
                "  read({ path })              Read a file",
                "  edit({ path, oldText, newText })  Replace exact text in a file",
                "  write({ path, content })    Create or overwrite a file",
                "  bash({ command, timeout? }) Run a shell command",
                "  grep({ pattern, path })     Search with ripgrep",
                "  find({ pattern, path })     Find files by glob",
                "  ls({ path })                List directory contents",
                "",
                "File I/O (bypasses context window):",
                "  load(path)                  File → string, directory → Map<path, content>",
                "  save(path, content)         Write without entering context",
                "",
                "Workers (async subagents in tmux sessions):",
                "  spawn(task, opts?)          Spawn worker → WorkerHandle (returns immediately)",
                "  h.status                    'running' | 'done' | 'crashed'",
                "  h.result                    Promise<WorkerResult> — await when ready",
                "  h.branch                    Git branch name (e.g. 'spindle/w0')",
                "  h.cancel()                  Kill the worker",
                "  opts: { agent, model, tools, timeout, worktree, name }",
                "",
                "LLM (blocking one-shot, no tmux):",
                "  llm(prompt, opts?)          → { text, cost, model, turns, ok }",
                "  opts: { agent, model, tools, timeout, maxOutput }",
                "",
                "MCP (Model Context Protocol):",
                "  mcp()                       List MCP servers",
                "  mcp('server')               List tools for a server",
                "  mcp_call(server, tool, args) One-shot tool call → ToolResult",
                "  mcp_connect(server)         Persistent proxy → ServerProxy",
                "  mcp_disconnect(server?)     Close MCP connections",
                "",
                "Utilities:",
                "  sleep(ms)                   Async delay",
                "  diff(a, b, opts?)           Unified diff (files or strings)",
                "  retry(fn, opts?)            Exponential backoff (attempts, delay, backoff)",
                "  vars()                      List persistent REPL variables",
                "  clear(name?)                Free a variable",
                "  help()                      This message",
                "",
                "Commands:",
                "  /spindle attach <id>        Open worker's tmux session",
                "  /spindle list               Show active workers",
                "  /spindle reset              Reset REPL state",
                "  /spindle config subModel <m> Set default worker model",
                "",
                "Scoping: const, let, var, and bare assignments all persist across calls.",
            ].join("\n"),
        });

        return r;
    }

    pi.on("session_start", async (_event, ctx) => {
        repl = initRepl(ctx.cwd);
        sessionFile = ctx.sessionManager.getSessionFile();

        // Wire up dashboard widget
        (globalThis as any).__spindle_setWidget = (lines: string[]) => {
            try { ctx.ui.setWidget("spindle-workers", lines); } catch { /* ignore */ }
        };
        (globalThis as any).__spindle_clearWidget = () => {
            try { ctx.ui.setWidget("spindle-workers", undefined); } catch { /* ignore */ }
        };

        // Restore config from session
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
        killAllWorkers();
        stopPoller();
        clearDashboard();
        (globalThis as any).__spindle_setWidget = undefined;
        (globalThis as any).__spindle_clearWidget = undefined;
        await mcpCleanup();
        repl = null;
    });

    pi.registerTool({
        name: "spindle_exec",
        label: "Spindle",
        description: "Execute JavaScript in a persistent REPL with built-in tools, async workers, and MCP integration.",
        parameters: Type.Object({
            code: Type.String({ description: "JavaScript code to execute" }),
        }),
        promptGuidelines: [
            [
                "Use spindle_exec when you need to chain operations, transform data in JS, spawn async workers, or persist state across calls.",
                "Use native tools (read, edit, write, bash, etc.) for single straightforward operations.",
                "",
                "Inside spindle_exec, think in JavaScript, not bash. Use grep/find/load builtins to get data, then JS to transform it.",
                "  ✗ bash({command: \"find src -name '*.ts' | xargs grep 'export' | awk ...\"})  ← shell for data extraction",
                "  ✓ hits = await grep({pattern: 'export class', path: 'src/'})                  ← builtin + JS filtering",
                "  ✓ src = await load('src/'); [...src.entries()].filter(...)                     ← load + transform",
                "bash() is for builds, tests, git — tools that DO things. Not for searching or data extraction.",
                "",
                "Async workers (spawn subagents in isolated git worktrees with tmux sessions):",
                "  h = spawn('refactor auth module', { worktree: true })",
                "  // returns immediately — main agent keeps working",
                "  // later:",
                "  r = await h.result   // blocks until worker finishes",
                "  await bash({ command: `git merge ${h.branch}` })  // merge the work",
                "",
                "  // Spawn multiple from data:",
                "  files = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))",
                "  workers = files.map(f => spawn(`Review ${f}`, { name: f }))",
                "  results = await Promise.all(workers.map(w => w.result))",
                "",
                "LLM one-shots (blocking, no worktree):",
                "  r = await llm('Summarize this code', { model: 'haiku' })",
                "  // r.text, r.cost, r.ok",
                "",
                "const, let, var, and bare assignments all persist across calls.",
                "",
                "Search: grep({pattern,path}), find({pattern,path}), ls({path})",
                "Files: read({path}), edit({path,oldText,newText}), write({path,content})",
                "I/O: load(path) → string|Map, save(path, content)",
                "Shell: bash({command}) — for builds/tests/git only",
                "Workers: spawn(task, opts?) → WorkerHandle { id, branch, status, result, cancel() }",
                "LLM: llm(prompt, opts?) → { text, cost, model, turns, ok }",
                "MCP: mcp(server?) → list, mcp_call(server, tool, args), mcp_connect(server), mcp_disconnect()",
                "Utils: sleep(ms), diff(a,b), retry(fn,opts?), vars(), clear(name?), help()",
            ].join("\n"),
        ],

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            if (!repl) repl = initRepl(ctx.cwd);

            const code = params.code;
            if (!code) {
                return {
                    content: [{ type: "text", text: "Error: 'code' is required." }],
                    details: { code: "", error: true } satisfies SpindleExecDetails,
                    isError: true,
                };
            }

            currentOnUpdate = onUpdate;
            currentSignal = signal;
            currentCode = code;

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
                currentOnUpdate = undefined;
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

    pi.registerTool({
        name: "spindle_status",
        label: "Spindle Status",
        description: "Show REPL variables, active workers, usage stats, and configuration.",
        parameters: Type.Object({}),

        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            if (!repl) repl = initRepl(ctx.cwd);

            const variables = repl.getVariables();
            const workers = getActiveWorkers();

            // Build worker summary
            const workerLines: string[] = [];
            for (const [id, h] of workers) {
                const elapsed = Date.now() - h.startTime;
                const duration = elapsed < 60000 ? `${(elapsed / 1000).toFixed(0)}s` : `${(elapsed / 60000).toFixed(1)}m`;
                workerLines.push(`  ${id}: ${h.status} (${duration}) — ${h.task.slice(0, 60)}`);
            }

            const details: SpindleStatusDetails = {
                variables,
                usage: { ...cumulativeUsage },
                config: { subModel, outputLimit: 8192 },
            };

            const varSummary = variables.length > 0
                ? variables.map(v => `  ${v.name}: ${v.type} = ${v.preview}`).join("\n")
                : "  (none)";

            const parts = [
                "Spindle Status", "", "Variables:", varSummary, "",
            ];

            if (workerLines.length > 0) {
                parts.push("Workers:");
                parts.push(...workerLines);
                parts.push("");
            }

            parts.push(
                `Usage: ${cumulativeUsage.totalLlmCalls} sub-agent calls, $${cumulativeUsage.totalCost.toFixed(4)}`,
                `Config: sub-model=${subModel || "(default)"}`,
            );

            return {
                content: [{ type: "text", text: parts.join("\n") }],
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

    // --- Commands ---

    pi.registerCommand("spindle", {
        description: "Spindle REPL control — reset, config, run scripts, attach to workers, list workers",
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
                    ctx.ui.notify("Usage: /spindle config <subModel> <value>", "warning");
                }
            } else if (sub === "attach") {
                const workerId = parts[1];
                if (!workerId) {
                    ctx.ui.notify("Usage: /spindle attach <worker-id>", "warning");
                    return;
                }
                const handle = getWorker(workerId);
                if (!handle) {
                    ctx.ui.notify(`No worker found with id: ${workerId}`, "error");
                    return;
                }
                // Determine how to attach
                const inTmux = !!process.env.TMUX;
                if (inTmux) {
                    // Switch to the worker's tmux session
                    try {
                        execSync(`tmux switch-client -t ${JSON.stringify(handle.session)}`, { stdio: "pipe" });
                        ctx.ui.notify(`Switched to ${handle.session}`, "info");
                    } catch (err: any) {
                        ctx.ui.notify(`Failed to switch: ${err.message}. Try: tmux attach -t ${handle.session}`, "error");
                    }
                } else {
                    // Not in tmux — try to open a new terminal
                    const terminal = process.env.TERMINAL || "xterm";
                    try {
                        nodeSpawn(terminal, ["-e", "tmux", "attach", "-t", handle.session], {
                            detached: true,
                            stdio: "ignore",
                        }).unref();
                        ctx.ui.notify(`Opening ${handle.session} in new terminal`, "info");
                    } catch {
                        ctx.ui.notify(`Run manually: tmux attach -t ${handle.session}`, "info");
                    }
                }
            } else if (sub === "list") {
                const workers = getActiveWorkers();
                if (workers.size === 0) {
                    ctx.ui.notify("No active workers", "info");
                    return;
                }
                const lines: string[] = [];
                for (const [id, h] of workers) {
                    const elapsed = Date.now() - h.startTime;
                    const duration = elapsed < 60000 ? `${(elapsed / 1000).toFixed(0)}s` : `${(elapsed / 60000).toFixed(1)}m`;
                    const resolved = (h as any).resolved;
                    const icon = resolved ? "✓" : "⏳";
                    lines.push(`${icon} ${id} (${duration}) tmux:${h.session} branch:${h.branch}`);
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

export { Repl } from "./repl.js";
export { createDiff, retry, createContextTools } from "./builtins.js";
export type { RetryOptions } from "./builtins.js";
export { createToolWrappers, createFileIO, load, save } from "./tools.js";
export { discoverAgents, resolveAgent, setExtensionDir, getExtensionDir } from "./agents.js";
export type { SpindleExecDetails, SpindleStatusDetails } from "./render.js";
export { mcpList, mcpCall, mcpConnect, mcpDisconnect, mcpCleanup } from "./mcp.js";
export { spawn, killAllWorkers, getActiveWorkers, getWorker } from "./workers.js";
export type { WorkerHandle, WorkerResult, SpawnOptions } from "./workers.js";
