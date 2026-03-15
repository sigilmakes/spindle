import { describe, it, expect } from "vitest";
import { parseEpisode, EPISODE_SUFFIX } from "../src/threads.js";
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
        const text = `<episode>
status: failure
summary: Could not complete the task.
findings:
artifacts:
blockers:
- Missing API credentials
</episode>`;

        const ep = parseEpisode(makeResult(text, { exitCode: 1 }), { task: "t", agent: "a" });
        expect(ep.status).toBe("failure");
        expect(ep.blockers).toEqual(["Missing API credentials"]);
    });

    it("parses blocked status", () => {
        const text = `<episode>
status: blocked
summary: Blocked on dependency.
findings:
artifacts:
blockers:
- Waiting for auth service
</episode>`;

        const ep = parseEpisode(makeResult(text), { task: "t", agent: "a" });
        expect(ep.status).toBe("blocked");
        expect(ep.blockers).toEqual(["Waiting for auth service"]);
    });

    it("falls back gracefully when no episode block present", () => {
        const ep = parseEpisode(makeResult("Just some text output"), { task: "t", agent: "a" });
        expect(ep.status).toBe("success");
        expect(ep.summary).toBe("Just some text output");
        expect(ep.findings).toEqual([]);
        expect(ep.raw).toBe("Just some text output");
    });

    it("falls back to failure on non-zero exit with no block", () => {
        const ep = parseEpisode(makeResult("error text", { exitCode: 1 }), { task: "t", agent: "a" });
        expect(ep.status).toBe("failure");
    });

    it("falls back on empty output", () => {
        const ep = parseEpisode(makeResult(""), { task: "t", agent: "a" });
        expect(ep.status).toBe("success");
        expect(ep.summary).toBe("(no output)");
    });

    it("counts tool calls from messages", () => {
        const result = makeResult("done", {
            messages: [
                {
                    role: "assistant" as const,
                    content: [
                        { type: "toolCall" as const, id: "1", name: "read", arguments: {} },
                        { type: "toolCall" as const, id: "2", name: "bash", arguments: {} },
                        { type: "text" as const, text: "done" },
                    ],
                    timestamp: Date.now(),
                },
            ],
        });
        const ep = parseEpisode(result, { task: "t", agent: "a" });
        expect(ep.toolCalls).toBe(2);
    });

    it("preserves raw output", () => {
        const text = "raw content\n<episode>\nstatus: success\nsummary: ok\nfindings:\nartifacts:\nblockers:\n</episode>";
        const ep = parseEpisode(makeResult(text), { task: "t", agent: "a" });
        expect(ep.raw).toBe(text);
    });
});

describe("EPISODE_SUFFIX", () => {
    it("contains the episode template", () => {
        expect(EPISODE_SUFFIX).toContain("<episode>");
        expect(EPISODE_SUFFIX).toContain("status:");
        expect(EPISODE_SUFFIX).toContain("summary:");
        expect(EPISODE_SUFFIX).toContain("findings:");
        expect(EPISODE_SUFFIX).toContain("artifacts:");
        expect(EPISODE_SUFFIX).toContain("blockers:");
    });
});
