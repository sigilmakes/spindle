import { describe, it, expect } from "vitest";
import {
    formatCodeForDisplay,
    formatExecResult,
    formatStatusResult,
    formatDispatchUpdate,
    type SpindleExecDetails,
    type SpindleStatusDetails,
} from "../src/render.js";
import type { Episode, ThreadState, DisplayItem } from "../src/threads.js";

const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as any;

function makeEpisode(overrides?: Partial<Episode>): Episode {
    return {
        status: "success", summary: "Did the thing", findings: [], artifacts: [],
        blockers: [], toolCalls: 3, raw: "", task: "test task", agent: "scout",
        model: "test", cost: 0.01, duration: 2000,
        ...overrides,
    };
}

function makeThreadState(overrides?: Partial<ThreadState>): ThreadState {
    return {
        index: 0, task: "test task", agent: "scout",
        status: "pending", displayItems: [], toolCount: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        startTime: 0, durationMs: 0, cost: 0,
        ...overrides,
    };
}

describe("formatCodeForDisplay", () => {
    it("formats short code with header", () => {
        const result = formatCodeForDisplay('console.log("hi")', theme);
        expect(result).toContain("spindle_exec");
        expect(result).toContain('console.log("hi")');
    });

    it("shows all code lines without truncation", () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
        const result = formatCodeForDisplay(lines, theme);
        expect(result).toContain("line0");
        expect(result).toContain("line29");
        expect(result).not.toContain("more lines");
    });

    it("handles empty code", () => {
        expect(formatCodeForDisplay("", theme)).toContain("spindle_exec");
    });
});

describe("formatExecResult", () => {
    it("formats successful result", () => {
        const result = {
            content: [{ type: "text" as const, text: "output here" }],
            details: { code: "x = 1", durationMs: 150, error: false } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("✓");
        expect(text).toContain("output here");
    });

    it("formats error result", () => {
        const result = {
            content: [{ type: "text" as const, text: "Error: boom" }],
            details: { code: "bad()", durationMs: 50, error: true } satisfies SpindleExecDetails,
        };
        expect(formatExecResult(result, false, theme)).toContain("✗");
    });

    it("renders thread columns when threadStates present", () => {
        const states: ThreadState[] = [
            makeThreadState({
                status: "done", agent: "scout", task: "analyze code",
                durationMs: 3000, cost: 0.02,
                displayItems: [
                    { type: "toolCall", name: "read", args: { path: "src/index.ts" }, done: true },
                    { type: "text", text: "Let me analyze..." },
                    { type: "toolCall", name: "grep", args: { pattern: "TODO", path: "src/" }, done: true },
                ],
                episode: makeEpisode({ summary: "Found 3 issues" }),
            }),
            makeThreadState({
                index: 1, status: "running", agent: "scout", task: "check tests",
                startTime: Date.now() - 5000, toolCount: 2,
                displayItems: [
                    { type: "toolCall", name: "read", args: { path: "test/repl.test.ts" }, done: true },
                    { type: "toolCall", name: "bash", args: { command: "npm test" }, done: false },
                ],
            }),
        ];
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 5000, error: false, threadStates: states } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("Dispatch: 1/2 complete");
        expect(text).toContain("scout");
        expect(text).toContain("read");
        expect(text).toContain("✓");
        expect(text).toContain("grep");
        expect(text).toContain("npm test");
        expect(text).toContain("Working...");
    });

    it("collapses earlier tools", () => {
        const items: DisplayItem[] = Array.from({ length: 15 }, (_, i) => ({
            type: "toolCall" as const, name: "read", args: { path: `file${i}.ts` }, done: true,
        }));
        const states: ThreadState[] = [
            makeThreadState({ status: "done", displayItems: items, episode: makeEpisode() }),
        ];
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 100, error: false, threadStates: states } satisfies SpindleExecDetails,
        };
        const collapsed = formatExecResult(result, false, theme);
        expect(collapsed).toContain("+5 earlier tools");
        const expanded = formatExecResult(result, true, theme);
        expect(expanded).not.toContain("earlier tools");
    });

    it("handles zero threads", () => {
        const result = {
            content: [{ type: "text" as const, text: "done" }],
            details: { code: "x", durationMs: 10, error: false } satisfies SpindleExecDetails,
        };
        expect(formatExecResult(result, false, theme)).not.toContain("Dispatch");
    });

    it("handles blocked episodes", () => {
        const states: ThreadState[] = [
            makeThreadState({
                status: "done",
                episode: makeEpisode({ status: "blocked", summary: "Stuck" }),
            }),
        ];
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 100, error: false, threadStates: states } satisfies SpindleExecDetails,
        };
        expect(formatExecResult(result, false, theme)).toContain("⚠");
    });

    it("handles many threads (>6)", () => {
        const states = Array.from({ length: 8 }, (_, i) =>
            makeThreadState({ index: i, agent: `scout-${i}`, status: "done", episode: makeEpisode() })
        );
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 100, error: false, threadStates: states } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("8/8 complete");
        expect(text).toContain("scout-0");
        expect(text).toContain("scout-7");
    });

    it("renders comm sent items with peer rank", () => {
        const states: ThreadState[] = [
            makeThreadState({
                status: "running", startTime: Date.now() - 1000,
                displayItems: [
                    { type: "comm", direction: "sent", peer: 1, msg: "changed interface" },
                ],
            }),
        ];
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 100, error: false, threadStates: states } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("→ rank 1: changed interface");
    });

    it("renders comm received items with peer rank", () => {
        const states: ThreadState[] = [
            makeThreadState({
                index: 1, status: "running", startTime: Date.now() - 1000,
                displayItems: [
                    { type: "comm", direction: "received", peer: 0, msg: "here are the fields" },
                ],
            }),
        ];
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 100, error: false, threadStates: states } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("← rank 0: here are the fields");
    });

    it("renders comm broadcast sent as 'all'", () => {
        const states: ThreadState[] = [
            makeThreadState({
                status: "running", startTime: Date.now() - 1000,
                displayItems: [
                    { type: "comm", direction: "sent", peer: -1, msg: "status update" },
                ],
            }),
        ];
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 100, error: false, threadStates: states } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("→ all: status update");
    });

    it("shows thinking text", () => {
        const states: ThreadState[] = [
            makeThreadState({
                status: "running", startTime: Date.now() - 1000,
                displayItems: [{ type: "text", text: "Let me analyze the auth module..." }],
            }),
        ];
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 100, error: false, threadStates: states } satisfies SpindleExecDetails,
        };
        expect(formatExecResult(result, false, theme)).toContain("Let me analyze");
    });

    it("renders warning display items", () => {
        const states: ThreadState[] = [
            makeThreadState({
                status: "running", startTime: Date.now() - 1000,
                displayItems: [
                    { type: "toolCall", name: "edit", args: { path: "src/app.ts" }, done: true },
                    { type: "warning", text: "⚠ File collision: src/app.ts written by threads 0, 1" },
                ],
            }),
        ];
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 100, error: false, threadStates: states } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("File collision");
        expect(text).toContain("src/app.ts");
    });
});

describe("formatDispatchUpdate", () => {
    it("shows pending threads", () => {
        const text = formatDispatchUpdate([makeThreadState(), makeThreadState({ index: 1 })]);
        expect(text).toContain("2 threads");
        expect(text).toContain("0 done");
    });

    it("shows running threads", () => {
        const text = formatDispatchUpdate([
            makeThreadState({ status: "running", startTime: Date.now() - 5000, toolCount: 3 }),
        ]);
        expect(text).toContain("1 running");
        expect(text).toContain("3 tools");
    });

    it("shows done threads with summary", () => {
        const text = formatDispatchUpdate([
            makeThreadState({
                status: "done", durationMs: 3000,
                episode: makeEpisode({ status: "success", summary: "Fixed the bug" }),
            }),
        ]);
        expect(text).toContain("1 done");
        expect(text).toContain("Fixed the bug");
    });

    it("shows mixed state", () => {
        const text = formatDispatchUpdate([
            makeThreadState({ status: "done", durationMs: 2000, episode: makeEpisode() }),
            makeThreadState({ index: 1, status: "running", startTime: Date.now() - 1000, toolCount: 1 }),
            makeThreadState({ index: 2, status: "pending" }),
        ]);
        expect(text).toContain("1 done");
        expect(text).toContain("1 running");
        expect(text).toContain("1 pending");
    });

    it("shows file collision warnings", () => {
        const text = formatDispatchUpdate([
            makeThreadState({
                status: "done", durationMs: 2000, episode: makeEpisode(),
                displayItems: [
                    { type: "warning", text: "⚠ File collision: src/app.ts written by threads 0, 1" },
                ],
            }),
            makeThreadState({
                index: 1, status: "done", durationMs: 3000, episode: makeEpisode(),
                displayItems: [
                    { type: "warning", text: "⚠ File collision: src/app.ts written by threads 0, 1" },
                ],
            }),
        ]);
        expect(text).toContain("File collision");
        // Should deduplicate — same warning on both threads shown once
        const matches = text.match(/File collision/g);
        expect(matches).toHaveLength(1);
    });
});

describe("formatStatusResult", () => {
    it("formats status with variables", () => {
        const details: SpindleStatusDetails = {
            variables: [{ name: "x", type: "number", preview: "42" }],
            usage: { totalCost: 0.05, totalEpisodes: 3, totalLlmCalls: 7 },
            config: { subModel: "fast-model", outputLimit: 8192 },
        };
        const text = formatStatusResult(details, theme);
        expect(text).toContain("x");
        expect(text).toContain("42");
        expect(text).toContain("fast-model");
    });

    it("formats status with no variables", () => {
        const details: SpindleStatusDetails = {
            variables: [],
            usage: { totalCost: 0, totalEpisodes: 0, totalLlmCalls: 0 },
            config: { subModel: undefined, outputLimit: 8192 },
        };
        expect(formatStatusResult(details, theme)).toContain("No variables");
    });
});
