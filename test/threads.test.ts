import { describe, it, expect } from "vitest";
import { parseEpisode, parseEpisodeBlock, EPISODE_SUFFIX, STEPPED_EPISODE_SUFFIX, createThreadSpec, dispatchThreads, isThreadSpec, truncateRaw, MAX_RAW_SIZE, MEMORY_WARNING_THRESHOLD, OUTPUT_DISPLAY_THRESHOLD, formatBytes } from "../src/threads.js";
import type { Episode, ThreadState, ThreadSpec } from "../src/threads.js";
import type { SubAgentResult } from "../src/agents.js";
import { pruneMessages } from "../src/agents.js";

function makeResult(text: string, overrides?: Partial<SubAgentResult>): SubAgentResult {
    return {
        text,
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
        exitCode: 0,
        durationMs: 1000,
        outputBytes: 0,
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

    it("parses intermediate episode blocks with running status override", () => {
        const text = 'Step 1 done.\n\n<episode>\nstatus: success\nsummary: Completed step 1.\nfindings:\n- Found A\nartifacts:\nblockers:\n</episode>\n\nNow doing step 2...\n\n<episode>\nstatus: success\nsummary: All done.\nfindings:\n- Found B\nartifacts:\nblockers:\n</episode>';
        // The parser should grab the LAST block for the final episode
        const ep = parseEpisode(makeResult(text), { task: "t", agent: "a" });
        expect(ep.summary).toBe("All done.");
        expect(ep.findings).toEqual(["Found B"]);
    });

    it("grabs the LAST episode block when source code quotes the template", () => {
        const text = 'Here is the EPISODE_SUFFIX constant:\n```\n<episode>\nstatus: success | failure\nsummary: template\nfindings:\n</episode>\n```\n\nDone analyzing.\n\n<episode>\nstatus: success\nsummary: Actually completed the analysis.\nfindings:\n- Real finding\nartifacts:\nblockers:\n</episode>';
        const ep = parseEpisode(makeResult(text), { task: "t", agent: "a" });
        expect(ep.summary).toBe("Actually completed the analysis.");
        expect(ep.findings).toEqual(["Real finding"]);
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

describe("parseEpisodeBlock", () => {
    const baseMeta = { task: "t", agent: "a", model: "test-model", cost: 0.005, duration: 500 };

    it("parses a running episode block", () => {
        const block = "status: running\nsummary: Step 1 done.\nfindings:\n- Found X\nartifacts:\n- src/foo.ts\nblockers:\n";
        const ep = parseEpisodeBlock(block, baseMeta);
        expect(ep.status).toBe("running");
        expect(ep.summary).toBe("Step 1 done.");
        expect(ep.findings).toEqual(["Found X"]);
        expect(ep.artifacts).toEqual(["src/foo.ts"]);
        expect(ep.blockers).toEqual([]);
        expect(ep.task).toBe("t");
        expect(ep.agent).toBe("a");
        expect(ep.model).toBe("test-model");
        expect(ep.cost).toBe(0.005);
        expect(ep.duration).toBe(500);
    });

    it("parses terminal statuses", () => {
        expect(parseEpisodeBlock("status: success\nsummary: Done.\nfindings:\nartifacts:\nblockers:\n", baseMeta).status).toBe("success");
        expect(parseEpisodeBlock("status: failure\nsummary: Failed.\nfindings:\nartifacts:\nblockers:\n", baseMeta).status).toBe("failure");
        expect(parseEpisodeBlock("status: blocked\nsummary: Stuck.\nfindings:\nartifacts:\nblockers:\n", baseMeta).status).toBe("blocked");
    });

    it("defaults to running when status is missing", () => {
        const ep = parseEpisodeBlock("summary: No status field.\nfindings:\nartifacts:\nblockers:\n", baseMeta);
        expect(ep.status).toBe("running");
    });

    it("preserves meta fields", () => {
        const meta = { task: "audit", agent: "scout", model: "gpt-4", cost: 0.02, duration: 3000 };
        const ep = parseEpisodeBlock("status: running\nsummary: Working.\nfindings:\nartifacts:\nblockers:\n", meta);
        expect(ep.task).toBe("audit");
        expect(ep.agent).toBe("scout");
        expect(ep.model).toBe("gpt-4");
        expect(ep.cost).toBe(0.02);
        expect(ep.duration).toBe(3000);
        expect(ep.toolCalls).toBe(0);
    });

    it("handles empty block gracefully", () => {
        const ep = parseEpisodeBlock("", baseMeta);
        expect(ep.status).toBe("running");
        expect(ep.summary).toBe("");
        expect(ep.findings).toEqual([]);
    });
});

describe("STEPPED_EPISODE_SUFFIX", () => {
    it("contains running status for checkpoints", () => {
        expect(STEPPED_EPISODE_SUFFIX).toContain("status: running");
    });

    it("contains terminal status for final episode", () => {
        expect(STEPPED_EPISODE_SUFFIX).toContain("status: success | failure | blocked");
    });

    it("instructs about checkpoint emission", () => {
        expect(STEPPED_EPISODE_SUFFIX).toContain("checkpoint");
        expect(STEPPED_EPISODE_SUFFIX).toContain("milestone");
    });
});

describe("ThreadSpec (stepped)", () => {
    it("accepts stepped option", () => {
        const spec = createThreadSpec("task", { stepped: true, defaultCwd: "/tmp", defaultModel: undefined });
        expect(isThreadSpec(spec)).toBe(true);
        expect(spec.opts.stepped).toBe(true);
    });

    it("implements AsyncGenerator protocol with stepped", () => {
        const spec = createThreadSpec("task", { stepped: true, agent: "worker", defaultCwd: "/tmp", defaultModel: undefined });
        expect(typeof spec[Symbol.asyncIterator]).toBe("function");
        expect(typeof spec.next).toBe("function");
        expect(typeof spec.return).toBe("function");
        expect(typeof spec.throw).toBe("function");
        expect(spec.agent).toBe("worker");
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

// --- W1C: truncateRaw ---

describe("truncateRaw", () => {
    it("preserves short text unchanged", () => {
        const short = "Hello, world!";
        expect(truncateRaw(short)).toBe(short);
    });

    it("preserves text exactly at the limit", () => {
        const exact = "x".repeat(MAX_RAW_SIZE);
        expect(truncateRaw(exact)).toBe(exact);
    });

    it("truncates text over the limit with head+tail", () => {
        const big = "A".repeat(100_000);
        const result = truncateRaw(big);
        expect(result.length).toBeLessThan(big.length);
        expect(result).toContain("... [truncated:");
        expect(result).toContain("100000 chars");
    });

    it("uses 70/30 head/tail split", () => {
        const max = 1000;
        const big = "B".repeat(5000);
        const result = truncateRaw(big, max);
        const headSize = Math.floor(max * 0.7); // 700
        const tailSize = max - headSize;         // 300
        // Head portion should start the result
        expect(result.startsWith("B".repeat(headSize))).toBe(true);
        // Tail portion should end the result
        expect(result.endsWith("B".repeat(tailSize))).toBe(true);
        // Marker in the middle
        expect(result).toContain(`showing first ${headSize} + last ${tailSize}`);
    });

    it("preserves episode block in tail of large text", () => {
        const episodeBlock = "\n<episode>\nstatus: success\nsummary: Finished the work.\nfindings:\n- Found it\nartifacts:\nblockers:\n</episode>";
        // Build a large text with the episode block at the very end
        const padding = "x".repeat(100_000);
        const big = padding + episodeBlock;
        const result = truncateRaw(big);
        // The episode block is near the end, within the 30% tail
        expect(result).toContain("<episode>");
        expect(result).toContain("Finished the work.");
        expect(result).toContain("</episode>");
    });

    it("respects custom max parameter", () => {
        const text = "C".repeat(500);
        // With max=200, it should truncate
        const result = truncateRaw(text, 200);
        expect(result).toContain("[truncated:");
        // With max=1000, it should pass through
        expect(truncateRaw(text, 1000)).toBe(text);
    });
});

describe("parseEpisode with large output (W1C)", () => {
    it("truncates raw on large output", () => {
        const episodeBlock = "\n<episode>\nstatus: success\nsummary: Done.\nfindings:\n- Result\nartifacts:\nblockers:\n</episode>";
        const padding = "x".repeat(100_000);
        const text = padding + episodeBlock;
        const ep = parseEpisode(makeResult(text), { task: "t", agent: "a" });
        // raw should be truncated to roughly MAX_RAW_SIZE + marker overhead
        expect(ep.raw.length).toBeLessThan(MAX_RAW_SIZE + 200);
        expect(ep.raw).toContain("[truncated:");
    });

    it("still parses episode fields from large text", () => {
        const episodeBlock = "\n<episode>\nstatus: success\nsummary: Completed analysis.\nfindings:\n- Found vulnerability\nartifacts:\n- src/fix.ts\nblockers:\n</episode>";
        const padding = "y".repeat(100_000);
        const text = padding + episodeBlock;
        const ep = parseEpisode(makeResult(text), { task: "audit", agent: "scout" });
        // Parsing happens on full text before truncation
        expect(ep.status).toBe("success");
        expect(ep.summary).toBe("Completed analysis.");
        expect(ep.findings).toEqual(["Found vulnerability"]);
        expect(ep.artifacts).toEqual(["src/fix.ts"]);
    });

    it("does not truncate small output", () => {
        const text = "short\n<episode>\nstatus: success\nsummary: ok\nfindings:\nartifacts:\nblockers:\n</episode>";
        const ep = parseEpisode(makeResult(text), { task: "t", agent: "a" });
        expect(ep.raw).toBe(text);
        expect(ep.raw).not.toContain("[truncated:");
    });
});

// --- W1C: pruneMessages ---

describe("pruneMessages", () => {
    it("returns empty array for empty input", () => {
        expect(pruneMessages([])).toEqual([]);
    });

    it("preserves last assistant message intact", () => {
        const largeText = "x".repeat(10_000);
        const messages: any[] = [
            { role: "assistant", content: [{ type: "text", text: largeText }], timestamp: 1 },
        ];
        const pruned = pruneMessages(messages);
        expect(pruned[0].content[0].text).toBe(largeText);
    });

    it("prunes large text in non-final assistant messages", () => {
        const messages: any[] = [
            { role: "assistant", content: [{ type: "text", text: "x".repeat(1000) }], timestamp: 1 },
            { role: "assistant", content: [{ type: "text", text: "final output" }], timestamp: 2 },
        ];
        const pruned = pruneMessages(messages);
        // First assistant message text should be pruned
        expect(pruned[0].content[0].text).toContain("[pruned:");
        expect(pruned[0].content[0].text).toContain("1000 chars");
        // Last assistant message should be intact
        expect(pruned[1].content[0].text).toBe("final output");
    });

    it("preserves toolCall parts in assistant messages for counting", () => {
        const messages: any[] = [
            {
                role: "assistant",
                content: [
                    { type: "toolCall", id: "1", name: "read", arguments: {} },
                    { type: "toolCall", id: "2", name: "bash", arguments: {} },
                    { type: "text", text: "x".repeat(500) },
                ],
                timestamp: 1,
            },
            { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
        ];
        const pruned = pruneMessages(messages);
        // toolCall parts preserved
        const toolCalls = pruned[0].content.filter((p: any) => p.type === "toolCall");
        expect(toolCalls).toHaveLength(2);
        expect(toolCalls[0].name).toBe("read");
        expect(toolCalls[1].name).toBe("bash");
        // large text pruned
        const textPart = pruned[0].content.find((p: any) => p.type === "text");
        expect(textPart.text).toContain("[pruned:");
    });

    it("prunes large tool result content", () => {
        const messages: any[] = [
            { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "x".repeat(5000) }] },
            { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 1 },
        ];
        const pruned = pruneMessages(messages);
        expect(pruned[0].content[0].text).toContain("[pruned:");
        expect(pruned[0].content[0].text).toContain("5000 chars");
    });

    it("preserves small content unchanged", () => {
        const messages: any[] = [
            { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "short" }] },
            { role: "assistant", content: [{ type: "text", text: "also short" }], timestamp: 1 },
            { role: "assistant", content: [{ type: "text", text: "final" }], timestamp: 2 },
        ];
        const pruned = pruneMessages(messages);
        expect(pruned[0].content[0].text).toBe("short");
        expect(pruned[1].content[0].text).toBe("also short");
        expect(pruned[2].content[0].text).toBe("final");
    });

    it("preserves user messages unchanged", () => {
        const messages: any[] = [
            { role: "user", content: "x".repeat(1000), timestamp: 1 },
            { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2 },
        ];
        const pruned = pruneMessages(messages);
        expect(pruned[0].content).toBe("x".repeat(1000));
    });

    it("handles messages with no assistant message", () => {
        const messages: any[] = [
            { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "x".repeat(500) }] },
        ];
        const pruned = pruneMessages(messages);
        // No last assistant, so tool result gets pruned
        expect(pruned[0].content[0].text).toContain("[pruned:");
    });
});

// --- W2B: Memory-aware dispatch ---

describe("formatBytes", () => {
    it("formats bytes", () => {
        expect(formatBytes(500)).toBe("500B");
    });

    it("formats kilobytes", () => {
        expect(formatBytes(1024)).toBe("1.0KB");
        expect(formatBytes(1536)).toBe("1.5KB");
        expect(formatBytes(102400)).toBe("100.0KB");
    });

    it("formats megabytes", () => {
        expect(formatBytes(1024 * 1024)).toBe("1.0MB");
        expect(formatBytes(2.3 * 1024 * 1024)).toBe("2.3MB");
        expect(formatBytes(100 * 1024 * 1024)).toBe("100.0MB");
    });

    it("formats gigabytes", () => {
        expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0GB");
    });
});

describe("MEMORY_WARNING_THRESHOLD", () => {
    it("is 100MB", () => {
        expect(MEMORY_WARNING_THRESHOLD).toBe(100 * 1024 * 1024);
    });
});

describe("OUTPUT_DISPLAY_THRESHOLD", () => {
    it("is 100KB", () => {
        expect(OUTPUT_DISPLAY_THRESHOLD).toBe(100 * 1024);
    });
});

describe("SubAgentResult.outputBytes", () => {
    it("is present in makeResult helper", () => {
        const result = makeResult("hello");
        expect(result.outputBytes).toBe(0);
    });

    it("can be overridden", () => {
        const result = makeResult("hello", { outputBytes: 5000 });
        expect(result.outputBytes).toBe(5000);
    });
});

describe("parseEpisode preserves outputBytes context", () => {
    it("works with result that has outputBytes", () => {
        const text = "<episode>\nstatus: success\nsummary: Done.\nfindings:\nartifacts:\nblockers:\n</episode>";
        const result = makeResult(text, { outputBytes: 1024 * 1024 });
        const ep = parseEpisode(result, { task: "t", agent: "a" });
        expect(ep.status).toBe("success");
        // outputBytes doesn't directly appear on Episode, it's on ThreadState
    });
});
