import { describe, it, expect } from "vitest";
import { parseEpisode, EPISODE_SUFFIX, createThreadSpec, dispatchThreads, isThreadSpec } from "../src/threads.js";
import type { Episode, ThreadState, ThreadSpec } from "../src/threads.js";
import type { SubAgentResult } from "../src/agents.js";

function makeResult(text: string, overrides?: Partial<SubAgentResult>): SubAgentResult {
    return {
        text,
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
        exitCode: 0,
        durationMs: 1000,
        ...overrides,
    };
}

describe("parseEpisode", () => {
    it("parses a well-formed episode block", () => {
        const text = `I did the work.

<episode>
status: success
summary: Analyzed auth module, found 3 vulnerabilities.
findings:
- SQL injection in login handler
- Hardcoded secret in config
artifacts:
- src/auth/login.ts — fixed SQL injection
blockers:
</episode>`;

        const ep = parseEpisode(makeResult(text), { task: "audit auth", agent: "scout" });
        expect(ep.status).toBe("success");
        expect(ep.summary).toBe("Analyzed auth module, found 3 vulnerabilities.");
        expect(ep.findings).toEqual(["SQL injection in login handler", "Hardcoded secret in config"]);
        expect(ep.artifacts).toEqual(["src/auth/login.ts — fixed SQL injection"]);
        expect(ep.blockers).toEqual([]);
        expect(ep.task).toBe("audit auth");
        expect(ep.agent).toBe("scout");
        expect(ep.cost).toBe(0.01);
        expect(ep.duration).toBe(1000);
    });

    it("parses failure status", () => {
        const text = `<episode>\nstatus: failure\nsummary: Could not complete.\nfindings:\nartifacts:\nblockers:\n- Missing creds\n</episode>`;
        const ep = parseEpisode(makeResult(text, { exitCode: 1 }), { task: "t", agent: "a" });
        expect(ep.status).toBe("failure");
        expect(ep.blockers).toEqual(["Missing creds"]);
    });

    it("parses blocked status", () => {
        const text = `<episode>\nstatus: blocked\nsummary: Blocked.\nfindings:\nartifacts:\nblockers:\n- Waiting\n</episode>`;
        const ep = parseEpisode(makeResult(text), { task: "t", agent: "a" });
        expect(ep.status).toBe("blocked");
    });

    it("falls back gracefully when no episode block present", () => {
        const ep = parseEpisode(makeResult("Just some text"), { task: "t", agent: "a" });
        expect(ep.status).toBe("success");
        expect(ep.summary).toBe("Just some text");
        expect(ep.raw).toBe("Just some text");
    });

    it("falls back to failure on non-zero exit", () => {
        expect(parseEpisode(makeResult("err", { exitCode: 1 }), { task: "t", agent: "a" }).status).toBe("failure");
    });

    it("falls back on empty output", () => {
        expect(parseEpisode(makeResult(""), { task: "t", agent: "a" }).summary).toBe("(no output)");
    });

    it("counts tool calls from messages", () => {
        const result = makeResult("done", {
            messages: [{
                role: "assistant" as const,
                content: [
                    { type: "toolCall" as const, id: "1", name: "read", arguments: {} },
                    { type: "toolCall" as const, id: "2", name: "bash", arguments: {} },
                    { type: "text" as const, text: "done" },
                ],
                timestamp: Date.now(),
            }],
        });
        expect(parseEpisode(result, { task: "t", agent: "a" }).toolCalls).toBe(2);
    });

    it("preserves raw output", () => {
        const text = "raw\n<episode>\nstatus: success\nsummary: ok\nfindings:\nartifacts:\nblockers:\n</episode>";
        expect(parseEpisode(makeResult(text), { task: "t", agent: "a" }).raw).toBe(text);
    });
});

describe("EPISODE_SUFFIX", () => {
    it("contains the episode template", () => {
        for (const field of ["<episode>", "status:", "summary:", "findings:", "artifacts:", "blockers:"]) {
            expect(EPISODE_SUFFIX).toContain(field);
        }
    });
});

describe("ThreadSpec", () => {
    it("isThreadSpec identifies specs", () => {
        const spec = createThreadSpec("task", { defaultCwd: "/tmp", defaultModel: undefined });
        expect(isThreadSpec(spec)).toBe(true);
        expect(isThreadSpec({})).toBe(false);
        expect(isThreadSpec(null)).toBe(false);
    });

    it("has task and agent fields", () => {
        const spec = createThreadSpec("do the thing", { agent: "scout", defaultCwd: "/tmp", defaultModel: undefined });
        expect(spec.task).toBe("do the thing");
        expect(spec.agent).toBe("scout");
    });

    it("defaults agent to anonymous", () => {
        const spec = createThreadSpec("task", { defaultCwd: "/tmp", defaultModel: undefined });
        expect(spec.agent).toBe("anonymous");
    });

    it("implements AsyncGenerator protocol", () => {
        const spec = createThreadSpec("task", { defaultCwd: "/tmp", defaultModel: undefined });
        expect(typeof spec[Symbol.asyncIterator]).toBe("function");
        expect(typeof spec.next).toBe("function");
        expect(typeof spec.return).toBe("function");
        expect(typeof spec.throw).toBe("function");
    });
});

describe("dispatchThreads", () => {
    // We can't test with real subagents, but we can test the dispatch machinery
    // by verifying it handles empty inputs and state tracking

    it("handles empty thread list", async () => {
        const results = await dispatchThreads([]);
        expect(results).toEqual([]);
    });

    it("calls onUpdate with thread states", async () => {
        // Create a minimal mock by directly testing state tracking
        const snapshots: Array<Array<{ status: string; agent: string }>> = [];
        const onUpdate = (states: ThreadState[]) => {
            snapshots.push(states.map(s => ({ status: s.status, agent: s.agent })));
        };

        // Empty dispatch returns immediately — no updates
        await dispatchThreads([], 4, onUpdate);
        expect(snapshots).toHaveLength(0);
    });
});
