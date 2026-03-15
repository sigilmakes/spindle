import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Repl } from "./repl.js";
import { createToolWrappers, createFileIO } from "./tools.js";
import { spawnSubAgent, killAllSubAgents } from "./agents.js";
import { createThread, dispatchThreads, type Episode, type ThreadOptions } from "./threads.js";
import {
    formatCodeForDisplay, formatExecResult, formatStatusResult,
    type SpindleExecDetails, type SpindleStatusDetails,
} from "./render.js";

export default function spindle(pi: ExtensionAPI) {
    let repl: Repl | null = null;
    let cwd = process.cwd();
    let subModel: string | undefined;

    const cumulativeUsage = { totalCost: 0, totalEpisodes: 0, totalLlmCalls: 0 };

    // Per-exec state threaded through to dispatch for onUpdate
    let currentOnUpdate: AgentToolUpdateCallback<SpindleExecDetails> | undefined;
    let currentCode: string = "";

    function initRepl(workingDir: string): Repl {
        const r = new Repl();
        cwd = workingDir;

        r.inject(createToolWrappers(cwd));

        const fileIO = createFileIO(cwd);
        r.inject({ load: fileIO.load, save: fileIO.save });

        r.inject({
            llm: async (prompt: string, opts?: { agent?: string; model?: string; tools?: string[]; timeout?: number }) => {
                const result = await spawnSubAgent(prompt, {
                    agent: opts?.agent, model: opts?.model ?? subModel,
                    tools: opts?.tools, timeout: opts?.timeout,
                    defaultCwd: cwd, defaultModel: subModel,
                });
                cumulativeUsage.totalCost += result.usage.cost;
                cumulativeUsage.totalLlmCalls++;
                if (result.error) throw new Error(result.error);
                return result.text;
            },
        });

        r.inject({
            thread: (task: string, opts?: ThreadOptions) =>
                createThread(task, { ...opts, defaultCwd: cwd, defaultModel: subModel }),
            dispatch: async (threads: AsyncGenerator<Episode, void, undefined>[], concurrency?: number) => {
                const onEpisode = (completedSoFar: Episode[]) => {
                    if (!currentOnUpdate) return;
                    currentOnUpdate({
                        content: [{ type: "text", text: `Dispatching: ${completedSoFar.length}/${threads.length} complete` }],
                        details: {
                            code: currentCode,
                            episodes: completedSoFar,
                            error: false,
                        },
                    });
                };

                const episodes = await dispatchThreads(threads, concurrency, onEpisode);
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

        return r;
    }

    pi.on("session_start", (_event, ctx) => {
        repl = initRepl(ctx.cwd);

        // P1-T12: Restore sub-model config from session entries
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i] as any;
            if (entry.customType === "spindle-config" && entry.data?.subModel !== undefined) {
                subModel = entry.data.subModel;
                break;
            }
        }
    });

    pi.on("session_shutdown", () => { killAllSubAgents(); repl = null; });

    pi.registerTool({
        name: "spindle_exec",
        label: "Spindle",
        description: "Execute JavaScript in a persistent REPL with built-in tools, sub-agent orchestration, and file I/O.",
        parameters: Type.Object({
            code: Type.String({ description: "JavaScript code to execute" }),
        }),
        promptGuidelines: [
            "You have a persistent JavaScript REPL via `spindle_exec`. Variables persist across calls (use plain assignment, not const/let).",
            "Built-in tools: `await read({path})`, `await bash({command})`, `await grep({pattern, path})`, `await find({pattern, path})`, `await edit({path, oldText, newText})`, `await write({path, content})`, `await ls({path})`.",
            "  These have pi's truncation limits — use `load()` for full file content.",
            "`await load(path)` loads a file (→ string) or directory (→ Map) into a variable without entering context.",
            "`await save(path, content)` writes data out without entering context.",
            "One-shot sub-agents: `await llm(prompt, { agent?, model?, tools?, timeout? })` → string.",
            "Threads: `thread(task, opts?)` → AsyncGenerator<Episode>. `await dispatch([thread(...), ...])` → Episode[].",
            "Episodes have: status, summary, findings, artifacts, blockers, cost, duration.",
            "Sub-agents are full pi processes with ALL tools (mcp, extensions).",
            "`await sleep(ms)` for delays.",
            "REPL output truncated to 8192 chars. Store results in variables, console.log what you need.",
        ],

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            if (!repl) repl = initRepl(ctx.cwd);

            (repl as any).__lastEpisodes = undefined;
            currentOnUpdate = onUpdate;
            currentCode = params.code;

            const result = await repl.exec(params.code, signal);
            const episodes: Episode[] = (repl as any).__lastEpisodes || [];

            currentOnUpdate = undefined;

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
                    code: params.code,
                    episodes: episodes.length > 0 ? episodes : undefined,
                    durationMs: result.durationMs,
                    error: !!result.error,
                } satisfies SpindleExecDetails,
                isError: !!result.error,
            };
        },

        renderCall(args, theme) {
            return new Text(formatCodeForDisplay(args.code, theme), 0, 0);
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
                config: { subModel, outputLimit: 8192, timeoutMs: 300_000 },
            };

            const varSummary = variables.length > 0
                ? variables.map(v => `  ${v.name}: ${v.type} = ${v.preview}`).join("\n")
                : "  (none)";

            return {
                content: [{ type: "text", text: [
                    "Spindle Status", "", "Variables:", varSummary, "",
                    `Usage: ${cumulativeUsage.totalLlmCalls} LLM calls, ${cumulativeUsage.totalEpisodes} episodes, $${cumulativeUsage.totalCost.toFixed(4)}`,
                    `Config: sub-model=${subModel || "(default)"}, output-limit=8192, timeout=300s`,
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
        description: "Spindle REPL control — reset, config, or prime for orchestration",
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
            } else if (sub === "status") {
                pi.sendUserMessage("Show Spindle status using the spindle_status tool.");
            } else if (!sub || sub === "help") {
                ctx.ui.notify("Usage: /spindle <reset|config|status|task>", "info");
            } else {
                pi.sendUserMessage(`Use Spindle (spindle_exec) for this task with wave-based orchestration:\n\n${args}`);
            }
        },
    });
}

export { Repl } from "./repl.js";
export { createToolWrappers, createFileIO, load, save } from "./tools.js";
export { spawnSubAgent, discoverAgents, resolveAgent } from "./agents.js";
export { createThread, dispatchThreads, parseEpisode, EPISODE_SUFFIX } from "./threads.js";
export type { Episode, ThreadOptions } from "./threads.js";
export type { SpindleExecDetails, SpindleStatusDetails } from "./render.js";
