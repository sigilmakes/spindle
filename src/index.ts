import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Repl } from "./repl.js";
import { createToolWrappers, createFileIO } from "./tools.js";
import { createDiff, retry, createContextTools } from "./builtins.js";
import { spawnSubAgent, killAllSubAgents, setExtensionDir } from "./agents.js";
import {
    createThreadSpec, dispatchThreads, isThreadSpec,
    type Episode, type ThreadOptions, type ThreadSpec, type ThreadState, type DispatchOptions,
} from "./threads.js";
import { CommClient } from "./comm/index.js";
import { setLockNotifier, releaseAllLocks } from "./locks.js";
import {
    formatCodeForDisplay, formatFileExecForDisplay, formatExecResult, formatStatusResult, formatDispatchUpdate,
    type SpindleExecDetails, type SpindleStatusDetails,
} from "./render.js";

/** Default cap on llm() return value (bytes). */
export const DEFAULT_LLM_MAX_OUTPUT = 50 * 1024; // 50KB

/**
 * Truncate an LLM output string to `max` characters, preserving a head+tail
 * window so the caller can still see how the response started and ended.
 *
 * If `max` is `false` or `Infinity`, no truncation is applied.
 * Returns the original string when it fits within the limit.
 */
export function truncateLlmOutput(
    text: string,
    max: number | false | undefined,
    defaultMax: number = DEFAULT_LLM_MAX_OUTPUT,
): string {
    const limit = max === false ? Infinity : (max ?? defaultMax);
    if (!Number.isFinite(limit) || text.length <= limit) return text;
    const headSize = Math.floor(limit * 0.7);
    const tailSize = Math.floor(limit * 0.3);
    const head = text.slice(0, headSize);
    const tail = text.slice(-tailSize);
    return (
        head +
        `\n\n... [truncated: ${text.length} total chars, showing first ${headSize} + last ${tailSize}. Use { maxOutput: false } for full output] ...\n\n` +
        tail
    );
}

// Register the extension directory so sub-agents can be spawned with --extension
// pointing back at this extension's source entry point.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// If running from dist/, resolve to the source src/ directory.
// If already in src/ (jiti), use as-is.
const srcDir = __dirname.endsWith("/dist") || __dirname.endsWith("\\dist")
    ? path.join(path.dirname(__dirname), "src")
    : __dirname;
setExtensionDir(srcDir);

export default function spindle(pi: ExtensionAPI) {
    // Register SPINDLE.md as a skill so pi includes it in the system prompt
    const extensionDir = path.dirname(fileURLToPath(import.meta.url));
    const skillPath = path.join(extensionDir, "..", "skills", "SPINDLE.md");
    pi.on("resources_discover", () => {
        if (fs.existsSync(skillPath)) {
            return { skillPaths: [skillPath] };
        }
    });

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
        "llm", "thread", "dispatch",
        // utilities
        "sleep", "diff", "retry", "vars", "clear",
    ]);

    let repl: Repl | null = null;
    let cwd = process.cwd();
    let subModel: string | undefined;

    const cumulativeUsage = { totalCost: 0, totalEpisodes: 0, totalLlmCalls: 0 };

    // Per-exec state — threaded through closures to dispatch/thread calls
    let currentOnUpdate: AgentToolUpdateCallback<SpindleExecDetails> | undefined;
    let currentSignal: AbortSignal | undefined;
    let currentCode = "";

    function initRepl(workingDir: string): Repl {
        const r = new Repl();
        cwd = workingDir;

        r.inject(createToolWrappers(cwd));

        const fileIO = createFileIO(cwd);
        r.inject({ load: fileIO.load, save: fileIO.save });

        r.inject({
            llm: async (prompt: string, opts?: {
                agent?: string; model?: string; tools?: string[];
                timeout?: number; spindle?: boolean;
                maxOutput?: number | false;
            }) => {
                const result = await spawnSubAgent(prompt, {
                    agent: opts?.agent, model: opts?.model ?? subModel,
                    tools: opts?.tools, timeout: opts?.timeout,
                    spindle: opts?.spindle,
                    defaultCwd: cwd, defaultModel: subModel,
                }, currentSignal);
                cumulativeUsage.totalCost += result.usage.cost;
                cumulativeUsage.totalLlmCalls++;
                if (result.error) throw new Error(result.error);
                return truncateLlmOutput(result.text, opts?.maxOutput);
            },
        });

        r.inject({
            thread: (task: string, opts?: ThreadOptions) =>
                createThreadSpec(task, { ...opts, defaultCwd: cwd, defaultModel: subModel }, currentSignal),

            dispatch: async (specs: ThreadSpec[], opts?: { communicate?: boolean }) => {
                const onUpdate = currentOnUpdate;
                const code = currentCode;
                const signal = currentSignal;

                const onDispatchUpdate = (threadStates: ThreadState[]) => {
                    if (!onUpdate) return;
                    const doneEpisodes = threadStates.filter(t => t.episode).map(t => t.episode!);
                    onUpdate({
                        content: [{ type: "text", text: formatDispatchUpdate(threadStates) }],
                        details: {
                            code,
                            threadStates,
                            episodes: doneEpisodes.length > 0 ? doneEpisodes : undefined,
                            durationMs: Math.max(0, ...threadStates.filter(t => t.startTime > 0).map(t =>
                                t.status === "done" ? t.durationMs : Date.now() - t.startTime)),
                            error: false,
                        },
                    });
                };

                const episodes = await dispatchThreads(
                    specs,
                    { communicate: opts?.communicate },
                    onDispatchUpdate,
                    signal,
                );
                for (const ep of episodes) {
                    cumulativeUsage.totalCost += ep.cost;
                    cumulativeUsage.totalEpisodes++;
                }
                (repl as any).__lastEpisodes = episodes;
                return episodes;
            },
        });

        r.inject({
            sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
        });

        // --- Utility builtins: diff, retry, vars, clear ---
        r.inject({ diff: createDiff(cwd), retry });

        const ctxTools = createContextTools(r, BUILTIN_NAMES);
        r.inject({ vars: ctxTools.vars, clear: ctxTools.clear });

        return r;
    }

    let commClient: CommClient | null = null;

    pi.on("session_start", async (_event, ctx) => {
        repl = initRepl(ctx.cwd);

        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i] as any;
            if (entry.customType === "spindle-config" && entry.data?.subModel !== undefined) {
                subModel = entry.data.subModel;
                break;
            }
        }

        // If we're a sub-agent in a communicating dispatch, connect and register comm tools
        const commPath = process.env.SPINDLE_COMM;
        const rankStr = process.env.SPINDLE_RANK;
        const sizeStr = process.env.SPINDLE_SIZE;

        if (commPath && rankStr && sizeStr) {
            const rank = parseInt(rankStr, 10);
            const size = parseInt(sizeStr, 10);

            commClient = new CommClient(rank);
            try {
                await commClient.connect(commPath);
            } catch {
                commClient = null;
                return;
            }

            const client = commClient;

            // Wire file lock notifications to comm broadcast
            setLockNotifier((event, filePath) => {
                try {
                    client.broadcast(`${event}:${filePath}`);
                } catch { /* comm may be disconnected */ }
            });

            pi.registerTool({
                name: "spindle_send",
                label: "Send",
                description: `Send a message to another thread by rank. You are rank ${rank} of ${size}.`,
                parameters: Type.Object({
                    to: Type.Number({ description: "Destination thread rank" }),
                    msg: Type.String({ description: "Message to send" }),
                    data: Type.Optional(Type.Unknown({ description: "Structured data payload" })),
                }),
                async execute(_id, params) {
                    client.send(params.to, params.msg, params.data);
                    return { content: [{ type: "text", text: `Sent to rank ${params.to}.` }], details: undefined };
                },
            });

            pi.registerTool({
                name: "spindle_recv",
                label: "Receive",
                description: `Block until a message arrives from another thread. You are rank ${rank} of ${size}.`,
                parameters: Type.Object({
                    from: Type.Optional(Type.Number({ description: "Only receive from this rank" })),
                }),
                async execute(_id, params) {
                    const msg = await client.recv(params.from);
                    return {
                        content: [{ type: "text", text: `From rank ${msg.from}: ${msg.msg}${msg.data ? "\nData: " + JSON.stringify(msg.data) : ""}` }],
                        details: undefined,
                    };
                },
            });

            pi.registerTool({
                name: "spindle_broadcast",
                label: "Broadcast",
                description: `Send a message to all other threads. You are rank ${rank} of ${size}.`,
                parameters: Type.Object({
                    msg: Type.String({ description: "Message to broadcast" }),
                    data: Type.Optional(Type.Unknown({ description: "Structured data payload" })),
                }),
                async execute(_id, params) {
                    client.broadcast(params.msg, params.data);
                    return { content: [{ type: "text", text: `Broadcast to ${size - 1} threads.` }], details: undefined };
                },
            });

            pi.registerTool({
                name: "spindle_barrier",
                label: "Barrier",
                description: `Block until all ${size} threads reach this barrier. Use named barriers for multiple sync points. You are rank ${rank} of ${size}.`,
                parameters: Type.Object({
                    name: Type.Optional(Type.String({ description: "Barrier name (default: 'default'). Use distinct names for multiple sync points." })),
                }),
                async execute(_id, params) {
                    const barrierName = params.name ?? "default";
                    await client.barrier(barrierName);
                    return {
                        content: [{ type: "text", text: `Barrier '${barrierName}' released — all ${size} threads synchronized.` }],
                        details: undefined,
                    };
                },
            });
        }
    });

    pi.on("session_shutdown", () => {
        killAllSubAgents();
        releaseAllLocks();
        setLockNotifier(null);
        commClient?.disconnect();
        commClient = null;
        repl = null;
    });

    pi.registerTool({
        name: "spindle_exec",
        label: "Spindle",
        description: "Execute JavaScript in a persistent REPL with built-in tools, sub-agent orchestration, and file I/O.",
        parameters: Type.Object({
            code: Type.Optional(Type.String({ description: "JavaScript code to execute" })),
            file: Type.Optional(Type.String({ description: "Path to a .js or .mjs file to execute (alternative to code)" })),
        }),
        promptGuidelines: [
            "**Use `spindle_exec` for everything.** Do not call native tools (read, edit, write, bash, grep, find, ls) directly — use their REPL equivalents inside `spindle_exec`. The REPL has file locking, persistent variables, and all the same tools as builtins.",
            "Variables persist across `spindle_exec` calls (use plain assignment, not const/let). `const` and `let` are scoped to a single exec call and WILL be lost.",
            "Built-in tools: `await read({path})`, `await bash({command})`, `await grep({pattern, path})`, `await find({pattern, path})`, `await edit({path, oldText, newText})`, `await write({path, content})`, `await ls({path})`.",
            "  All return `ToolResult { output, error, ok, exitCode }`. Never throw — check `.ok` for success. Coerce to string with `${result}` or use `.output` directly.",
            "  These have pi's truncation limits (50KB/2000 lines) — use `load()` for full file content.",
            "`await load(path)` loads a file (→ string) or directory (→ Map) into a variable without entering context.",
            "`await save(path, content)` writes data out without entering context.",
            "**Guard your context window.** Prefer `load()` over `read()` — load stores data in a variable without outputting it. Use `grep`, `bash` with `awk`/`jq`/`head`/`tail` to extract what you need. Only `console.log` the specific lines or values you need to see — never dump entire files or large generated content.",
            "One-shot sub-agents: `await llm(prompt, { agent?, model?, tools?, timeout?, spindle? })` → string.",
            "llm() output is capped at 50KB by default. Use `{ maxOutput: false }` for full output, or `{ maxOutput: N }` for a custom byte limit.",
            "Threads: `thread(task, opts?)` → AsyncGenerator<Episode>. `await dispatch([thread(...), ...])` → Episode[].",
            "Episodes have: status, summary, findings, artifacts, blockers, cost, duration.",
            "Sub-agents are full pi processes with ALL tools (mcp, extensions).",
            "Recursive Spindle: pass `{ spindle: true }` to `thread()` or `llm()` to give the sub-agent its own Spindle REPL — it can dispatch its own threads.",
            "Thread communication: `dispatch([...], { communicate: true })` lets threads send/recv/broadcast to each other by rank during execution.",
            "Barriers: `spindle_barrier({ name: 'phase1' })` blocks until all threads reach it. Use for multi-phase work where phase 2 depends on all threads finishing phase 1.",
            "When dispatching threads, ensure each thread targets different files. Concurrent edits to the same file are detected (FileConflictError) and may cause thread failures.",
            "`diff(a, b, opts?)` compares two strings or files and returns a unified diff. If args are file paths that exist, reads them first. opts: `{ context?: number }`.",
            "`await retry(fn, opts?)` retries an async function with exponential backoff. opts: `{ attempts?, delay?, backoff?, onError? }`. Defaults: 3 attempts, 1s delay, 2x backoff.",
            "`vars()` lists user-defined REPL variables (excludes builtins). `clear(name)` removes a variable.",
            "`await sleep(ms)` for delays.",
            "REPL output truncated to 8192 chars. Store results in variables, console.log what you need.",
            "Execute scripts from files: `spindle_exec({ file: \"path/to/script.js\" })` — runs a .js/.mjs file in the same REPL context with all the same builtins.",
        ],

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            if (!repl) repl = initRepl(ctx.cwd);

            // Validate: exactly one of code or file must be provided
            if (!params.code && !params.file) {
                return {
                    content: [{ type: "text", text: "Error: Either 'code' or 'file' must be provided." }],
                    details: { code: "", error: true } satisfies SpindleExecDetails,
                    isError: true,
                };
            }
            if (params.code && params.file) {
                return {
                    content: [{ type: "text", text: "Error: Provide either 'code' or 'file', not both." }],
                    details: { code: "", error: true } satisfies SpindleExecDetails,
                    isError: true,
                };
            }

            // Resolve code — either inline or from file
            let code: string;
            let file: string | undefined;

            if (params.file) {
                file = params.file;
                const resolved = path.resolve(ctx.cwd, file);

                if (!/\.(js|mjs)$/.test(resolved)) {
                    return {
                        content: [{ type: "text", text: "Error: File must end in .js or .mjs" }],
                        details: { code: "", file, error: true } satisfies SpindleExecDetails,
                        isError: true,
                    };
                }

                try {
                    code = fs.readFileSync(resolved, "utf-8");
                } catch (err: any) {
                    return {
                        content: [{ type: "text", text: `Error reading file: ${err.message}` }],
                        details: { code: "", file, error: true } satisfies SpindleExecDetails,
                        isError: true,
                    };
                }
            } else {
                code = params.code!;
            }

            (repl as any).__lastEpisodes = undefined;
            currentOnUpdate = onUpdate;
            currentSignal = signal;
            currentCode = code;

            const abortCleanup = () => killAllSubAgents();
            signal?.addEventListener("abort", abortCleanup, { once: true });

            try {
                const result = await repl.exec(code, signal);
                const episodes: Episode[] = (repl as any).__lastEpisodes || [];

                const parts: string[] = [];
                if (result.output) parts.push(result.output);
                if (result.error) parts.push(`Error: ${result.error}`);

                if (episodes.length > 0) {
                    parts.push("\n--- Episodes ---");
                    for (const ep of episodes) {
                        let line = `[${ep.status}] ${ep.agent}: ${ep.summary}`;
                        if (ep.findings.length) line += "\n  Findings:\n" + ep.findings.map(f => `  - ${f}`).join("\n");
                        if (ep.artifacts.length) line += "\n  Artifacts: " + ep.artifacts.join(", ");
                        if (ep.blockers.length) line += "\n  Blockers: " + ep.blockers.join(", ");
                        parts.push(line);
                    }
                }

                return {
                    content: [{ type: "text", text: parts.join("\n") || "(no output)" }],
                    details: {
                        code,
                        file,
                        episodes: episodes.length > 0 ? episodes : undefined,
                        durationMs: result.durationMs,
                        error: !!result.error,
                    } satisfies SpindleExecDetails,
                    isError: !!result.error,
                };
            } finally {
                currentOnUpdate = undefined;
                currentSignal = undefined;
                signal?.removeEventListener("abort", abortCleanup);
            }
        },

        renderCall(args, theme) {
            if (args.file) {
                return new Text(formatFileExecForDisplay(args.file, theme), 0, 0);
            }
            return new Text(formatCodeForDisplay(args.code || "", theme), 0, 0);
        },

        renderResult(result, options, theme) {
            return new Text(formatExecResult(result as AgentToolResult<SpindleExecDetails>, options.expanded, theme), 0, 0);
        },
    });

    pi.registerTool({
        name: "spindle_status",
        label: "Spindle Status",
        description: "Show REPL variables, usage stats, and configuration.",
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

            return {
                content: [{ type: "text", text: [
                    "Spindle Status", "", "Variables:", varSummary, "",
                    `Usage: ${cumulativeUsage.totalLlmCalls} LLM calls, ${cumulativeUsage.totalEpisodes} episodes, $${cumulativeUsage.totalCost.toFixed(4)}`,
                    `Config: sub-model=${subModel || "(default)"}, output-limit=8192`,
                ].join("\n") }],
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
        description: "Spindle REPL control — reset, config, run scripts, or prime for orchestration",
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
                    ctx.ui.notify("Usage: /spindle config subModel <model>", "warning");
                }
            } else if (sub === "run") {
                const filePath = parts.slice(1).join(" ").trim();
                if (!filePath) {
                    ctx.ui.notify("Usage: /spindle run <path.js>", "warning");
                } else {
                    pi.sendUserMessage(`Execute this script using spindle_exec with the file parameter:\n\nspindle_exec({ file: ${JSON.stringify(filePath)} })`);
                }
            } else if (sub === "status") {
                pi.sendUserMessage("Show Spindle status using the spindle_status tool.");
            } else if (!sub || sub === "help") {
                ctx.ui.notify("Usage: /spindle <reset|config|status|run|task>", "info");
            } else {
                pi.sendUserMessage(`Use Spindle (spindle_exec) for this task with wave-based orchestration:\n\n${args}`);
            }
        },
    });
}

export { Repl } from "./repl.js";
export { createDiff, retry, createContextTools } from "./builtins.js";
export type { RetryOptions } from "./builtins.js";
export { createToolWrappers, createFileIO, load, save, FileConflictError, guardedWrite, createMtimeGuardedEditOperations, getMtimeMap } from "./tools.js";
export { spawnSubAgent, discoverAgents, resolveAgent, setExtensionDir, getExtensionDir } from "./agents.js";
export { createThreadSpec, dispatchThreads, parseEpisode, parseEpisodeBlock, EPISODE_SUFFIX, STEPPED_EPISODE_SUFFIX, isThreadSpec } from "./threads.js";
export type { Episode, ThreadOptions, ThreadSpec, ThreadState, DisplayItem } from "./threads.js";
export type { SpindleExecDetails, SpindleStatusDetails } from "./render.js";
