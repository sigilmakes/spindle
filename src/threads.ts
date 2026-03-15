import { spawnSubAgent, type SubAgentEvent, type SubAgentResult, type UsageStats } from "./agents.js";

export interface Episode {
    status: "success" | "failure" | "blocked" | "running";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];
    toolCalls: number;
    raw: string;
    task: string;
    agent: string;
    model: string;
    cost: number;
    duration: number;
}

export const EPISODE_SUFFIX = `
After completing your task, end your response with a structured episode block.
This block MUST be the last thing in your response.

<episode>
status: success | failure | blocked
summary: One paragraph describing what you accomplished and key conclusions.
findings:
- Finding or deliverable 1
- Finding or deliverable 2
artifacts:
- path/to/file — what was created or modified
blockers:
- (only if status is blocked) What's preventing progress
</episode>
`.trim();

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const COLLAPSED_ITEM_COUNT = 10;

export type DisplayItem =
    | { type: "text"; text: string }
    | { type: "toolCall"; name: string; args: Record<string, unknown>; done: boolean };

export interface ThreadState {
    index: number;
    task: string;
    agent: string;
    status: "pending" | "running" | "done";
    displayItems: DisplayItem[];
    toolCount: number;
    usage: UsageStats;
    startTime: number;
    durationMs: number;
    cost: number;
    model?: string;
    episode?: Episode;
}

export interface ThreadOptions {
    agent?: string;
    model?: string;
    tools?: string[];
    timeout?: number;
}

export interface ThreadSpec {
    __brand: "ThreadSpec";
    task: string;
    agent: string;
    opts: ThreadOptions & { defaultCwd: string; defaultModel?: string };
    signal?: AbortSignal;
    // AsyncGenerator protocol for direct consumption (for await...of)
    [Symbol.asyncIterator](): AsyncGenerator<Episode, void, undefined>;
    next(value?: undefined): Promise<IteratorResult<Episode, void>>;
    return(value?: void): Promise<IteratorResult<Episode, void>>;
    throw(e?: unknown): Promise<IteratorResult<Episode, void>>;
}

export function isThreadSpec(x: unknown): x is ThreadSpec {
    return typeof x === "object" && x !== null && (x as any).__brand === "ThreadSpec";
}

export function createThreadSpec(
    task: string,
    opts: ThreadOptions & { defaultCwd: string; defaultModel?: string },
    signal?: AbortSignal,
): ThreadSpec {
    let generator: AsyncGenerator<Episode, void, undefined> | null = null;

    const lazyGen = () => {
        if (!generator) {
            generator = (async function* () {
                const result = await spawnSubAgent(
                    task,
                    {
                        ...opts, systemPromptSuffix: EPISODE_SUFFIX,
                        defaultCwd: opts.defaultCwd, defaultModel: opts.defaultModel,
                    },
                    signal,
                );
                yield parseEpisode(result, { task, agent: opts.agent || "anonymous" });
            })();
        }
        return generator;
    };

    return {
        __brand: "ThreadSpec",
        task,
        agent: opts.agent || "anonymous",
        opts,
        signal,
        [Symbol.asyncIterator]() { return lazyGen(); },
        next(value?: undefined) { return lazyGen().next(value); },
        return(value?: void) { return lazyGen().return(value); },
        throw(e?: unknown) { return lazyGen().throw(e); },
    };
}

export type OnDispatchUpdate = (threads: ThreadState[]) => void;

export async function dispatchThreads(
    specs: ThreadSpec[],
    concurrency: number = DEFAULT_CONCURRENCY,
    onUpdate?: OnDispatchUpdate,
    signal?: AbortSignal,
): Promise<Episode[]> {
    if (specs.length === 0) return [];

    const limit = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY));
    const results: Episode[] = new Array(specs.length);
    let nextIndex = 0;

    const states: ThreadState[] = specs.map((spec, i) => ({
        index: i,
        task: spec.task,
        agent: spec.agent,
        status: "pending" as const,
        displayItems: [],
        toolCount: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        startTime: 0,
        durationMs: 0,
        cost: 0,
    }));

    const emit = () => onUpdate?.(states);
    emit();

    const workers = Array.from({ length: Math.min(limit, specs.length) }, async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= specs.length) return;

            const spec = specs[current];
            const state = states[current];
            state.status = "running";
            state.startTime = Date.now();
            emit();

            const onEvent = (event: SubAgentEvent) => {
                switch (event.type) {
                    case "tool_start":
                        state.displayItems.push({
                            type: "toolCall", name: event.toolName!, args: event.toolArgs || {}, done: false,
                        });
                        state.toolCount++;
                        break;
                    case "tool_end": {
                        // Mark the most recent matching tool call as done
                        for (let i = state.displayItems.length - 1; i >= 0; i--) {
                            const item = state.displayItems[i];
                            if (item.type === "toolCall" && item.name === event.toolName && !item.done) {
                                item.done = true;
                                break;
                            }
                        }
                        break;
                    }
                    case "text":
                        if (event.text) {
                            // Only keep the latest short thinking snippet
                            const snippet = event.text.split("\n")[0].slice(0, 80);
                            if (snippet.trim()) {
                                state.displayItems.push({ type: "text", text: snippet });
                            }
                        }
                        break;
                    case "turn":
                        if (event.usage) state.usage = { ...event.usage };
                        break;
                }
                state.durationMs = Date.now() - state.startTime;
                emit();
            };

            const result = await spawnSubAgent(
                spec.task,
                {
                    ...spec.opts,
                    systemPromptSuffix: EPISODE_SUFFIX,
                    defaultCwd: spec.opts.defaultCwd,
                    defaultModel: spec.opts.defaultModel,
                    onEvent,
                },
                signal ?? spec.signal,
            );

            const episode = parseEpisode(result, { task: spec.task, agent: spec.agent });
            results[current] = episode;
            state.status = "done";
            state.durationMs = Date.now() - state.startTime;
            state.cost = episode.cost;
            state.model = result.model;
            state.episode = episode;
            emit();
        }
    });

    await Promise.all(workers);
    return results;
}

// --- Episode parsing ---

export function parseEpisode(result: SubAgentResult, meta: { task: string; agent: string }): Episode {
    const raw = result.text;
    const match = raw.match(/<episode>([\s\S]*?)<\/episode>/);

    const base = {
        toolCalls: countToolCalls(result),
        raw,
        task: meta.task,
        agent: meta.agent,
        model: result.model || "unknown",
        cost: result.usage.cost,
        duration: result.durationMs,
    };

    if (!match) {
        return {
            ...base,
            status: result.exitCode === 0 ? "success" : "failure",
            summary: raw.slice(0, 500) || "(no output)",
            findings: [], artifacts: [], blockers: [],
        };
    }

    const block = match[1];
    const statusMatch = block.match(/status:\s*(success|failure|blocked)/i);
    const summaryMatch = block.match(/summary:\s*(.+?)(?=\nfindings:|\nartifacts:|\nblockers:|\n*$)/is);

    return {
        ...base,
        status: (statusMatch?.[1]?.toLowerCase() as Episode["status"]) || "success",
        summary: summaryMatch?.[1]?.trim() || "",
        findings: parseList(block, "findings"),
        artifacts: parseList(block, "artifacts"),
        blockers: parseList(block, "blockers"),
    };
}

function parseList(block: string, field: string): string[] {
    const match = block.match(new RegExp(`${field}:\\s*\\n((?:\\s*-\\s*.+\\n?)*)`, "i"));
    if (!match) return [];
    return match[1].split("\n").map(line => line.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
}

function countToolCalls(result: SubAgentResult): number {
    let count = 0;
    for (const msg of result.messages) {
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "toolCall") count++;
            }
        }
    }
    return count;
}

export { COLLAPSED_ITEM_COUNT };
