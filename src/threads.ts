import { spawnSubAgent, type SubAgentEvent, type SubAgentResult, type UsageStats } from "./agents.js";
import { CommServer } from "./comm/index.js";

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

export const STEPPED_EPISODE_SUFFIX = `
You are a worker agent. As you work, emit checkpoint blocks at natural milestones — after each major step, after a significant discovery, or before changing approach.

Checkpoint format (use status: running for intermediate checkpoints):

<episode>
status: running
summary: One paragraph describing what you just accomplished in this step.
findings:
- Key finding or deliverable from this step
artifacts:
- path/to/file — what was created or modified in this step
blockers:
</episode>

After completing your task, end your response with a final episode block.
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
    spindle?: boolean;
    stepped?: boolean;
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
            generator = createThreadGenerator(task, opts, signal);
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

/** Internal queue item for the stepped generator. */
type QueueItem =
    | { kind: "episode"; episode: Episode }
    | { kind: "done"; result: SubAgentResult };

/**
 * Create the async generator that drives a thread.
 *
 * All threads use the same generator machinery. Intermediate episodes are
 * only yielded when the sub-agent emits `<episode>` blocks with
 * `status: running`. Terminal statuses (success/failure/blocked) from the
 * event stream are ignored — the final episode is always parsed from the
 * complete SubAgentResult so it carries accurate cost, duration, and tool
 * call metadata.
 *
 * When `opts.stepped` is true the system prompt instructs the agent to emit
 * intermediate checkpoints. Without it, agents emit a single terminal
 * episode and the generator yields once — identical to V1 behaviour.
 */
function createThreadGenerator(
    task: string,
    opts: ThreadOptions & { defaultCwd: string; defaultModel?: string },
    signal?: AbortSignal,
): AsyncGenerator<Episode, void, undefined> {
    const meta = { task, agent: opts.agent || "anonymous" };
    const suffix = opts.stepped ? STEPPED_EPISODE_SUFFIX : EPISODE_SUFFIX;

    // Local AbortController for cleanup when the generator is closed early.
    const localAbort = new AbortController();
    if (signal) {
        if (signal.aborted) localAbort.abort();
        else signal.addEventListener("abort", () => localAbort.abort(), { once: true });
    }

    const queue: QueueItem[] = [];
    let resolveWaiter: (() => void) | null = null;

    const push = (item: QueueItem) => {
        queue.push(item);
        if (resolveWaiter) {
            const r = resolveWaiter;
            resolveWaiter = null;
            r();
        }
    };

    const onEvent = (event: SubAgentEvent) => {
        if (event.type === "episode_chunk" && event.episodeRaw) {
            const match = event.episodeRaw.match(/<episode>([\s\S]*?)<\/episode>/);
            if (match) {
                const ep = parseEpisodeBlock(match[1], {
                    task: meta.task, agent: meta.agent,
                    model: "unknown", cost: 0, duration: 0,
                });
                // Only yield intermediate (running) episodes.
                // Terminal episodes are handled by parseEpisode on the final result.
                if (ep.status === "running") {
                    push({ kind: "episode", episode: ep });
                }
            }
        }
    };

    // Start the subprocess — events flow into the queue via onEvent.
    const resultPromise = spawnSubAgent(
        task,
        {
            ...opts,
            systemPromptSuffix: suffix,
            onEvent,
            defaultCwd: opts.defaultCwd,
            defaultModel: opts.defaultModel,
        },
        localAbort.signal,
    );

    // When the subprocess finishes, push a done sentinel.
    resultPromise.then(
        result => push({ kind: "done", result }),
        error => push({
            kind: "done",
            result: {
                text: error?.message || "Unknown error",
                messages: [],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
                exitCode: 1,
                error: error?.message,
                durationMs: 0,
            },
        }),
    );

    return (async function* () {
        try {
            while (true) {
                // Wait for items to arrive in the queue.
                while (queue.length === 0) {
                    await new Promise<void>(resolve => { resolveWaiter = resolve; });
                }
                const item = queue.shift()!;
                if (item.kind === "done") {
                    // Yield the final episode parsed from the complete result
                    // (carries accurate cost, duration, tool calls, model).
                    yield parseEpisode(item.result, meta);
                    return;
                }
                yield item.episode;
            }
        } finally {
            // Kill the subprocess if the generator is closed early
            // (e.g. orchestrator calls .return() to abandon a thread).
            localAbort.abort();
        }
    })();
}

function truncateThinking(text: string): string | null {
    // Find the first meaningful line (skip markdown headings, blank lines, bullet prefixes)
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("#")) continue;
        if (trimmed === "---" || trimmed === "```") continue;

        // Truncate at word boundary
        if (trimmed.length <= 80) return trimmed;
        const cut = trimmed.lastIndexOf(" ", 80);
        return trimmed.slice(0, cut > 20 ? cut : 80) + "...";
    }
    return null;
}

function pruneTextItems(items: DisplayItem[], maxText: number): void {
    let textCount = 0;
    for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].type === "text") {
            textCount++;
            if (textCount > maxText) {
                items.splice(i, 1);
            }
        }
    }
}

export type OnDispatchUpdate = (threads: ThreadState[]) => void;

export interface DispatchOptions {
    concurrency?: number;
    communicate?: boolean;
}

export async function dispatchThreads(
    specs: ThreadSpec[],
    options?: DispatchOptions,
    onUpdate?: OnDispatchUpdate,
    signal?: AbortSignal,
): Promise<Episode[]> {
    if (specs.length === 0) return [];

    const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
    const communicate = options?.communicate ?? false;
    const limit = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY));
    const results: Episode[] = new Array(specs.length);
    let nextIndex = 0;

    // Start comm server if threads need to communicate
    let commServer: CommServer | null = null;
    let commSocketPath: string | null = null;
    if (communicate) {
        commServer = new CommServer();
        commSocketPath = await commServer.start();
    }

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
                            const snippet = truncateThinking(event.text);
                            if (snippet) {
                                state.displayItems.push({ type: "text", text: snippet });
                                // Cap text items — keep last 3, let tool calls accumulate freely
                                pruneTextItems(state.displayItems, 3);
                            }
                        }
                        break;
                    case "episode_chunk":
                        // Track intermediate episode checkpoints on thread state
                        if (event.episodeRaw) {
                            const m = event.episodeRaw.match(/<episode>([\s\S]*?)<\/episode>/);
                            if (m) {
                                const ep = parseEpisodeBlock(m[1], {
                                    task: spec.task, agent: spec.agent,
                                    model: "unknown", cost: 0, duration: 0,
                                });
                                if (ep.status === "running") {
                                    state.episode = ep;
                                }
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

            const commEnv = commSocketPath ? {
                SPINDLE_RANK: String(current),
                SPINDLE_SIZE: String(specs.length),
                SPINDLE_COMM: commSocketPath,
            } : undefined;

            const result = await spawnSubAgent(
                spec.task,
                {
                    ...spec.opts,
                    systemPromptSuffix: spec.opts.stepped ? STEPPED_EPISODE_SUFFIX : EPISODE_SUFFIX,
                    onEvent,
                    defaultCwd: spec.opts.defaultCwd,
                    defaultModel: spec.opts.defaultModel,
                    env: commEnv,
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

    try {
        await Promise.all(workers);
        return results;
    } finally {
        if (commServer) await commServer.stop();
    }
}

// --- Episode parsing ---

export function parseEpisodeBlock(
    block: string,
    meta: { task: string; agent: string; model: string; cost: number; duration: number },
): Episode {
    const statusMatch = block.match(/status:\s*(success|failure|blocked|running)/i);
    const summaryMatch = block.match(/summary:\s*(.+?)(?=\nfindings:|\nartifacts:|\nblockers:|\n*$)/is);
    return {
        status: (statusMatch?.[1]?.toLowerCase() as Episode["status"]) || "running",
        summary: summaryMatch?.[1]?.trim() || "",
        findings: parseList(block, "findings"),
        artifacts: parseList(block, "artifacts"),
        blockers: parseList(block, "blockers"),
        toolCalls: 0,
        raw: block,
        task: meta.task,
        agent: meta.agent,
        model: meta.model,
        cost: meta.cost,
        duration: meta.duration,
    };
}

export function parseEpisode(result: SubAgentResult, meta: { task: string; agent: string }): Episode {
    const raw = result.text;
    // Grab the LAST episode block — agents may quote the template when reading our source
    const allMatches = [...raw.matchAll(/<episode>([\s\S]*?)<\/episode>/g)];
    const match = allMatches.length > 0 ? allMatches[allMatches.length - 1] : null;

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
