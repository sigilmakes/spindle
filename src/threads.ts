import { spawnSubAgent, type SpawnOptions, type SubAgentResult } from "./agents.js";

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

export interface ThreadOptions {
    agent?: string;
    model?: string;
    tools?: string[];
    timeout?: number;
}

export function createThread(
    task: string,
    opts: ThreadOptions & { defaultCwd: string; defaultModel?: string },
    signal?: AbortSignal,
): AsyncGenerator<Episode, void, undefined> {
    return (async function* () {
        const result = await spawnSubAgent(
            task,
            {
                agent: opts.agent, model: opts.model, tools: opts.tools, timeout: opts.timeout,
                systemPromptSuffix: EPISODE_SUFFIX,
                defaultCwd: opts.defaultCwd, defaultModel: opts.defaultModel,
            },
            signal,
        );
        yield parseEpisode(result, { task, agent: opts.agent || "anonymous" });
    })();
}

export async function dispatchThreads(
    threads: AsyncGenerator<Episode, void, undefined>[],
    concurrency: number = DEFAULT_CONCURRENCY,
): Promise<Episode[]> {
    const limit = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY));
    const results: Episode[] = new Array(threads.length);
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(limit, threads.length) }, async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= threads.length) return;

            const episodes: Episode[] = [];
            for await (const ep of threads[current]) episodes.push(ep);

            results[current] = episodes[0] || {
                status: "failure" as const,
                summary: "Thread produced no episodes",
                findings: [], artifacts: [], blockers: [],
                toolCalls: 0, raw: "", task: "unknown", agent: "unknown",
                model: "unknown", cost: 0, duration: 0,
            };
        }
    });

    await Promise.all(workers);
    return results;
}
