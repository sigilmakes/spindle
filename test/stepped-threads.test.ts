/**
 * Integration tests for V2 stepped threads.
 *
 * These tests mock spawnSubAgent to simulate the subprocess emitting
 * intermediate <episode> blocks via onEvent callbacks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/agents.js", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        spawnSubAgent: vi.fn(),
    };
});

import { createThreadSpec, STEPPED_EPISODE_SUFFIX, EPISODE_SUFFIX } from "../src/threads.js";
import { spawnSubAgent, type SubAgentEvent, type SpawnOptions } from "../src/agents.js";

const mockSpawn = vi.mocked(spawnSubAgent);

function makeEpisodeChunk(status: string, summary: string, findings: string[] = []): SubAgentEvent {
    const findingsStr = findings.length > 0
        ? findings.map(f => `- ${f}`).join("\n")
        : "";
    return {
        type: "episode_chunk",
        episodeRaw: `<episode>\nstatus: ${status}\nsummary: ${summary}\nfindings:\n${findingsStr}\nartifacts:\nblockers:\n</episode>`,
    };
}

describe("stepped thread generator", () => {
    beforeEach(() => {
        mockSpawn.mockReset();
    });

    it("yields intermediate running episodes then final episode", async () => {
        mockSpawn.mockImplementation(async (_task, options, _signal) => {
            const onEvent = options.onEvent!;

            // Intermediate checkpoint 1
            onEvent(makeEpisodeChunk("running", "Analyzed 3 files.", ["Found auth module"]));

            await new Promise(r => setTimeout(r, 5));

            // Intermediate checkpoint 2
            onEvent(makeEpisodeChunk("running", "Refactored 2 files.", ["Tests passing"]));

            await new Promise(r => setTimeout(r, 5));

            // Final terminal episode (emitted via event but filtered — not "running")
            onEvent(makeEpisodeChunk("success", "All done.", ["Complete refactor"]));

            return {
                text: "<episode>\nstatus: success\nsummary: All done.\nfindings:\n- Complete refactor\nartifacts:\n- src/auth.ts\nblockers:\n</episode>",
                messages: [],
                usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.015, contextTokens: 150, turns: 3 },
                exitCode: 0,
                durationMs: 2000,
            };
        });

        const spec = createThreadSpec("complex refactor", {
            stepped: true,
            defaultCwd: "/tmp",
            defaultModel: undefined,
        });

        const episodes = [];
        for await (const ep of spec) {
            episodes.push(ep);
        }

        // 2 intermediate (running) + 1 final (success)
        expect(episodes).toHaveLength(3);

        // Intermediate episodes
        expect(episodes[0].status).toBe("running");
        expect(episodes[0].summary).toBe("Analyzed 3 files.");
        expect(episodes[0].findings).toEqual(["Found auth module"]);
        expect(episodes[0].cost).toBe(0); // intermediates don't have cost

        expect(episodes[1].status).toBe("running");
        expect(episodes[1].summary).toBe("Refactored 2 files.");

        // Final episode — parsed from SubAgentResult with full metadata
        expect(episodes[2].status).toBe("success");
        expect(episodes[2].summary).toBe("All done.");
        expect(episodes[2].cost).toBe(0.015);
        expect(episodes[2].duration).toBe(2000);
        expect(episodes[2].artifacts).toEqual(["src/auth.ts"]);
    });

    it("V1 thread (no stepped) yields single final episode", async () => {
        mockSpawn.mockResolvedValue({
            text: "<episode>\nstatus: success\nsummary: Done quickly.\nfindings:\n- One finding\nartifacts:\nblockers:\n</episode>",
            messages: [],
            usage: { input: 50, output: 25, cacheRead: 0, cacheWrite: 0, cost: 0.005, contextTokens: 75, turns: 1 },
            exitCode: 0,
            durationMs: 500,
        });

        const spec = createThreadSpec("simple task", {
            defaultCwd: "/tmp",
            defaultModel: undefined,
        });

        const episodes = [];
        for await (const ep of spec) {
            episodes.push(ep);
        }

        expect(episodes).toHaveLength(1);
        expect(episodes[0].status).toBe("success");
        expect(episodes[0].summary).toBe("Done quickly.");
        expect(episodes[0].cost).toBe(0.005);
    });

    it("uses STEPPED_EPISODE_SUFFIX when stepped, EPISODE_SUFFIX otherwise", async () => {
        mockSpawn.mockResolvedValue({
            text: "<episode>\nstatus: success\nsummary: ok\nfindings:\nartifacts:\nblockers:\n</episode>",
            messages: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
            exitCode: 0,
            durationMs: 100,
        });

        // Stepped thread
        const stepped = createThreadSpec("t", { stepped: true, defaultCwd: "/tmp", defaultModel: undefined });
        await stepped.next();
        expect(mockSpawn).toHaveBeenCalledWith(
            "t",
            expect.objectContaining({ systemPromptSuffix: STEPPED_EPISODE_SUFFIX }),
            expect.anything(),
        );

        mockSpawn.mockClear();

        // Non-stepped thread
        mockSpawn.mockResolvedValue({
            text: "<episode>\nstatus: success\nsummary: ok\nfindings:\nartifacts:\nblockers:\n</episode>",
            messages: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
            exitCode: 0,
            durationMs: 100,
        });

        const simple = createThreadSpec("t", { defaultCwd: "/tmp", defaultModel: undefined });
        await simple.next();
        expect(mockSpawn).toHaveBeenCalledWith(
            "t",
            expect.objectContaining({ systemPromptSuffix: EPISODE_SUFFIX }),
            expect.anything(),
        );
    });

    it("step-by-step consumption with .next()", async () => {
        mockSpawn.mockImplementation(async (_task, options, _signal) => {
            const onEvent = options.onEvent!;

            onEvent(makeEpisodeChunk("running", "Step 1"));
            await new Promise(r => setTimeout(r, 5));
            onEvent(makeEpisodeChunk("running", "Step 2"));
            await new Promise(r => setTimeout(r, 5));

            return {
                text: "<episode>\nstatus: success\nsummary: Final.\nfindings:\nartifacts:\nblockers:\n</episode>",
                messages: [],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
                exitCode: 0,
                durationMs: 1000,
            };
        });

        const t = createThreadSpec("multi-step", { stepped: true, defaultCwd: "/tmp", defaultModel: undefined });

        const step1 = await t.next();
        expect(step1.done).toBe(false);
        expect(step1.value!.status).toBe("running");
        expect(step1.value!.summary).toBe("Step 1");

        const step2 = await t.next();
        expect(step2.done).toBe(false);
        expect(step2.value!.status).toBe("running");
        expect(step2.value!.summary).toBe("Step 2");

        const final = await t.next();
        expect(final.done).toBe(false);
        expect(final.value!.status).toBe("success");
        expect(final.value!.summary).toBe("Final.");

        const end = await t.next();
        expect(end.done).toBe(true);
    });

    it("handles subprocess failure gracefully", async () => {
        mockSpawn.mockResolvedValue({
            text: "Something went wrong",
            messages: [],
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 15, turns: 1 },
            exitCode: 1,
            error: "Process failed",
            durationMs: 200,
        });

        const spec = createThreadSpec("failing task", {
            stepped: true,
            defaultCwd: "/tmp",
            defaultModel: undefined,
        });

        const episodes = [];
        for await (const ep of spec) {
            episodes.push(ep);
        }

        expect(episodes).toHaveLength(1);
        expect(episodes[0].status).toBe("failure");
    });

    it("handles promise rejection in spawnSubAgent", async () => {
        mockSpawn.mockRejectedValue(new Error("Spawn failed"));

        const spec = createThreadSpec("broken task", {
            stepped: true,
            defaultCwd: "/tmp",
            defaultModel: undefined,
        });

        const episodes = [];
        for await (const ep of spec) {
            episodes.push(ep);
        }

        expect(episodes).toHaveLength(1);
        expect(episodes[0].status).toBe("failure");
    });

    it("only intermediate episodes with status 'running' are yielded", async () => {
        mockSpawn.mockImplementation(async (_task, options, _signal) => {
            const onEvent = options.onEvent!;

            // Running → should be yielded
            onEvent(makeEpisodeChunk("running", "Checkpoint 1"));
            // Success → should NOT be yielded as intermediate (filtered out)
            onEvent(makeEpisodeChunk("success", "Premature success"));
            // Failure → should NOT be yielded as intermediate
            onEvent(makeEpisodeChunk("failure", "Premature failure"));
            // Running → should be yielded
            onEvent(makeEpisodeChunk("running", "Checkpoint 2"));

            await new Promise(r => setTimeout(r, 5));

            return {
                text: "<episode>\nstatus: success\nsummary: Final.\nfindings:\nartifacts:\nblockers:\n</episode>",
                messages: [],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
                exitCode: 0,
                durationMs: 100,
            };
        });

        const spec = createThreadSpec("filter test", {
            stepped: true,
            defaultCwd: "/tmp",
            defaultModel: undefined,
        });

        const episodes = [];
        for await (const ep of spec) {
            episodes.push(ep);
        }

        // 2 running intermediates + 1 final
        expect(episodes).toHaveLength(3);
        expect(episodes[0].status).toBe("running");
        expect(episodes[0].summary).toBe("Checkpoint 1");
        expect(episodes[1].status).toBe("running");
        expect(episodes[1].summary).toBe("Checkpoint 2");
        expect(episodes[2].status).toBe("success");
        expect(episodes[2].summary).toBe("Final.");
    });

    it("generator is lazy — does not start until iterated", async () => {
        mockSpawn.mockResolvedValue({
            text: "<episode>\nstatus: success\nsummary: ok\nfindings:\nartifacts:\nblockers:\n</episode>",
            messages: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
            exitCode: 0,
            durationMs: 100,
        });

        // Create spec but don't iterate
        createThreadSpec("lazy task", { defaultCwd: "/tmp", defaultModel: undefined });
        expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("abort cleanup on generator .return()", async () => {
        let capturedSignal: AbortSignal | undefined;

        mockSpawn.mockImplementation(async (_task, _options, signal) => {
            capturedSignal = signal;

            // Simulate a long-running task
            await new Promise(r => setTimeout(r, 100));

            return {
                text: "<episode>\nstatus: success\nsummary: ok\nfindings:\nartifacts:\nblockers:\n</episode>",
                messages: [],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
                exitCode: 0,
                durationMs: 100,
            };
        });

        const spec = createThreadSpec("abort test", {
            stepped: true,
            defaultCwd: "/tmp",
            defaultModel: undefined,
        });

        // Start iteration to trigger the lazy generator
        const iter = spec[Symbol.asyncIterator]();
        // Don't await — just trigger the spawn
        const nextPromise = iter.next();

        // Give the mock time to start
        await new Promise(r => setTimeout(r, 10));
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal!.aborted).toBe(false);

        // Close the generator early
        await iter.return();

        // The local abort signal should have been triggered
        expect(capturedSignal!.aborted).toBe(true);
    });
});
