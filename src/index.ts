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
/** Minimum maxOutput to prevent accidental data destruction. */
export const MIN_LLM_MAX_OUTPUT = 1024;

export function truncateLlmOutput(
    text: string,
    max: number | false | undefined,
    defaultMax: number = DEFAULT_LLM_MAX_OUTPUT,
): string {
    const raw = max === false ? Infinity : (max ?? defaultMax);
    const limit = Number.isFinite(raw) ? Math.max(raw, MIN_LLM_MAX_OUTPUT) : raw;
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
// Use whatever directory we're running from — dist/ or src/.
// If running from dist/, sub-agents load dist/index.js (pre-compiled, fast).
// If running from src/ via jiti, sub-agents load src/index.ts (compiled on the fly).
setExtensionDir(__dirname);

export default function spindle(pi: ExtensionAPI) {
    // Skills are bundled in the package (skills/repl/SKILL.md) and discovered
    // automatically via the "pi" manifest in package.json.
    const extensionDir = path.dirname(fileURLToPath(import.meta.url));

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
        "sleep", "diff", "retry", "vars", "clear", "help",
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
                name?: string; agent?: string; model?: string; tools?: string[];
                timeout?: number; spindle?: boolean;
                maxOutput?: number | false;
            }) => {
                // llm() is sugar for a single-thread dispatch — same observability
                const spec = createThreadSpec(prompt, {
                    name: opts?.name, agent: opts?.agent, model: opts?.model,
                    tools: opts?.tools, timeout: opts?.timeout,
                    spindle: opts?.spindle,
                    defaultCwd: cwd, defaultModel: subModel,
                }, currentSignal);

                const onUpdate = currentOnUpdate;
                const code = currentCode;

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
                    [spec], {}, onDispatchUpdate, currentSignal,
                );
                const ep = episodes[0];
                cumulativeUsage.totalCost += ep.cost;
                cumulativeUsage.totalEpisodes++;
                cumulativeUsage.totalLlmCalls++;

                // Apply maxOutput truncation to ep.output if specified
                const max = opts?.maxOutput;
                if (max !== undefined) {
                    ep.output = truncateLlmOutput(ep.output, max);
                }

                return ep;
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
                    cumulativeUsage.totalLlmCalls++;
                }
                repl!.lastEpisodes = episodes;
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

        // --- help() — discoverability without the skill doc ---
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
                "Sub-agents:",
                "  llm(prompt, opts?)          One-shot sub-agent → Episode",
                "  thread(task, opts?)         Create a ThreadSpec for dispatch",
                "  dispatch(specs, opts?)      Run threads in parallel → Episode[]",
                "",
                "  opts: { name, agent, model, tools, timeout, spindle, stepped, maxOutput }",
                "  Episode: { name, status, summary, findings, artifacts, blockers, output, cost }",
                "",
                "Utilities:",
                "  sleep(ms)                   Async delay",
                "  diff(a, b, opts?)           Unified diff (files or strings)",
                "  retry(fn, opts?)            Exponential backoff (attempts, delay, backoff)",
                "  vars()                      List persistent REPL variables",
                "  clear(name?)                Free a variable",
                "  help()                      This message",
                "",
                "Scoping: const, let, var, and bare assignments all persist across calls.",
            ].join("\n"),
        });

        return r;
    }

    // Fast-path: when the prompt is a direct script execution request (from CLI),
    // strip the system prompt to bare minimum so the agent just calls the tool.
    let scriptExecMode = false;

    pi.on("input", async (event) => {
        if (event.text.includes("spindle_exec({ file:") && event.text.includes("Execute this spindle script")) {
            scriptExecMode = true;
            // Strip to just the tool call instruction
            const match = event.text.match(/spindle_exec\(\{[^}]+\}\)/);
            if (match) {
                return { action: "transform" as const, text: match[0] };
            }
        }
        return { action: "continue" as const };
    });

    pi.on("before_agent_start", async (event) => {
        if (scriptExecMode) {
            scriptExecMode = false;
            return {
                systemPrompt: "You are a script runner. Call the spindle_exec tool exactly as specified. No other actions.",
            };
        }
    });

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
                description: `Block until the specified number of threads reach this barrier. You are rank ${rank} of ${size}. If count is omitted, waits for all ${size} threads.`,
                parameters: Type.Object({
                    name: Type.Optional(Type.String({ description: "Barrier name (default: 'default'). Use distinct names for multiple sync points." })),
                    count: Type.Optional(Type.Number({ description: `How many threads must arrive before releasing (default: ${size}). Use when only a subset of threads participates.` })),
                }),
                async execute(_id, params) {
                    const barrierName = params.name ?? "default";
                    const count = params.count ?? size;
                    await client.barrier(barrierName, count);
                    return {
                        content: [{ type: "text", text: `Barrier '${barrierName}' released — ${count} threads synchronized.` }],
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
            [
                "Use spindle_exec for ALL operations. Do not call read, edit, write, bash, grep, find, ls directly.",
                "",
                "IMPORTANT: Think in JavaScript, not bash. Use grep/find/load builtins to get data, then JS to transform it.",
                "  ✗ bash({command: \"find src -name '*.ts' | xargs grep 'export' | awk ...\"})  ← shell for data extraction",
                "  ✓ hits = await grep({pattern: 'export class', path: 'src/'})                  ← builtin + JS filtering",
                "  ✓ src = await load('src/'); [...src.entries()].filter(...)                     ← load + transform",
                "bash() is for builds, tests, git — tools that DO things. Not for searching or data extraction.",
                "",
                "When dispatching sub-agents, ALWAYS build tasks programmatically:",
                "  files = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))",
                "  tasks = files.map(f => thread(`Review ${f}`, { name: f, agent: 'scout' }))",
                "  results = await dispatch(tasks)",
                "Never hand-write similar thread() calls. Use .map() over data. Pass file paths in prompts, not file contents.",
                "",
                "const, let, var, and bare assignments all persist across calls.",
                "",
                "Search: grep({pattern,path}), find({pattern,path}), ls({path})",
                "Files: read({path}), edit({path,oldText,newText}), write({path,content})",
                "I/O: load(path) → string|Map, save(path, content)",
                "Shell: bash({command}) — for builds/tests/git only",
                "Agents: llm(prompt, opts?) → Episode, thread(task, opts?), dispatch(specs) → Episode[]",
                "Episode: { name, status, summary, findings[], artifacts[], blockers[], output, cost }",
                "Utils: sleep(ms), diff(a,b), retry(fn,opts?), vars(), clear(name?), help()",
            ].join("\n"),
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

                if (!/\.(js|mjs)$/.test(resolved) && !/\.spindle\.js$/.test(resolved)) {
                    return {
                        content: [{ type: "text", text: "Error: File must end in .js, .mjs, or .spindle.js" }],
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

            repl.lastEpisodes = [];
            currentOnUpdate = onUpdate;
            currentSignal = signal;
            currentCode = code;

            const abortCleanup = () => killAllSubAgents();
            signal?.addEventListener("abort", abortCleanup, { once: true });

            try {
                const result = await repl.exec(code, signal, {
                    hoistDeclarations: !file,
                });
                const episodes = repl.lastEpisodes as Episode[];

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
                    `Usage: ${cumulativeUsage.totalLlmCalls} sub-agents, $${cumulativeUsage.totalCost.toFixed(4)}`,
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
