import { describe, it, expect } from "vitest";
import {
    formatCodeForDisplay,
    formatExecResult,
    formatStatusResult,
    formatDispatchProgress,
    type SpindleExecDetails,
    type SpindleStatusDetails,
} from "../src/render.js";
import type { Episode, ThreadState } from "../src/threads.js";

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

describe("formatCodeForDisplay", () => {
    it("formats short code with header", () => {
        const result = formatCodeForDisplay('console.log("hi")', theme);
        expect(result).toContain("spindle_exec");
        expect(result).toContain('console.log("hi")');
    });

    it("truncates code beyond maxLines", () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
        const result = formatCodeForDisplay(lines, theme, 15);
        expect(result).toContain("15 more lines");
        expect(result).toContain("line0");
        expect(result).not.toContain("line20");
    });

    it("handles single-line code", () => {
        const result = formatCodeForDisplay("x = 1", theme);
        expect(result).toContain("x = 1");
        expect(result).not.toContain("more lines");
    });

    it("handles empty code", () => {
        const result = formatCodeForDisplay("", theme);
        expect(result).toContain("spindle_exec");
    });
});

describe("formatExecResult", () => {
    it("formats successful result with duration", () => {
        const result = {
            content: [{ type: "text" as const, text: "output here" }],
            details: { code: "x = 1", durationMs: 150, error: false } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("✓");
        expect(text).toMatch(/0\.\ds/);
        expect(text).toContain("output here");
    });

    it("formats error result", () => {
        const result = {
            content: [{ type: "text" as const, text: "Error: boom" }],
            details: { code: "bad()", durationMs: 50, error: true } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("✗");
        expect(text).toContain("Error");
    });

    it("formats dispatch episodes as columns", () => {
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: {
                code: "dispatch([...])", durationMs: 5000, error: false,
                episodes: [
                    makeEpisode({ agent: "scout", summary: "Found 3 issues", findings: ["issue A", "issue B"] }),
                    makeEpisode({ agent: "worker", summary: "Fixed them", status: "success" }),
                ],
            } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, true, theme);
        expect(text).toContain("Dispatch: 2/2 complete");
        expect(text).toContain("scout");
        expect(text).toContain("worker");
        expect(text).toContain("Found 3 issues");
        expect(text).toContain("issue A");
        expect(text).toContain("2 threads");
    });

    it("shows Ctrl+O hint in collapsed mode when findings exist", () => {
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: {
                code: "x", durationMs: 100, error: false,
                episodes: [makeEpisode({ findings: ["finding1"] })],
            } satisfies SpindleExecDetails,
        };
        const collapsed = formatExecResult(result, false, theme);
        expect(collapsed).toContain("Ctrl+O");
        const expanded = formatExecResult(result, true, theme);
        expect(expanded).not.toContain("Ctrl+O for findings");
    });

    it("truncates long output in collapsed mode", () => {
        const longOutput = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
        const result = {
            content: [{ type: "text" as const, text: longOutput }],
            details: { code: "x", durationMs: 100, error: false } satisfies SpindleExecDetails,
        };
        const collapsed = formatExecResult(result, false, theme);
        expect(collapsed).toContain("30 more lines");
        const expanded = formatExecResult(result, true, theme);
        expect(expanded).not.toContain("more lines");
    });

    it("handles zero episodes", () => {
        const result = {
            content: [{ type: "text" as const, text: "done" }],
            details: { code: "x", durationMs: 10, error: false } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).not.toContain("Dispatch");
        expect(text).toContain("done");
    });

    it("handles failed episodes", () => {
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: {
                code: "x", durationMs: 100, error: false,
                episodes: [makeEpisode({ status: "failure", summary: "Crashed", agent: "worker" })],
            } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("✗");
        expect(text).toContain("Crashed");
    });

    it("handles blocked episodes with blockers", () => {
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: {
                code: "x", durationMs: 100, error: false,
                episodes: [makeEpisode({ status: "blocked", blockers: ["missing creds"] })],
            } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("⚠");
        expect(text).toContain("missing creds");
    });

    it("handles many episodes (>6)", () => {
        const episodes = Array.from({ length: 8 }, (_, i) =>
            makeEpisode({ agent: `scout-${i}`, task: `task ${i}`, summary: `summary ${i}` })
        );
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 100, error: false, episodes } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("8/8 complete");
        expect(text).toContain("scout-0");
        expect(text).toContain("scout-7");
    });

    it("handles empty output and no episodes", () => {
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: { code: "x", durationMs: 10, error: false } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("✓");
    });

    it("shows artifacts in expanded mode", () => {
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: {
                code: "x", durationMs: 100, error: false,
                episodes: [makeEpisode({ artifacts: ["src/fix.ts", "test/fix.test.ts"] })],
            } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, true, theme);
        expect(text).toContain("src/fix.ts");
        expect(text).toContain("test/fix.test.ts");
    });
});

describe("formatStatusResult", () => {
    it("formats status with variables", () => {
        const details: SpindleStatusDetails = {
            variables: [
                { name: "x", type: "number", preview: "42" },
                { name: "data", type: "object", preview: "{a, b}" },
            ],
            usage: { totalCost: 0.05, totalEpisodes: 3, totalLlmCalls: 7 },
            config: { subModel: "fast-model", outputLimit: 8192, timeoutMs: 300000 },
        };
        const text = formatStatusResult(details, theme);
        expect(text).toContain("x");
        expect(text).toContain("42");
        expect(text).toContain("Episodes: 3");
        expect(text).toContain("LLM calls: 7");
        expect(text).toContain("fast-model");
    });

    it("formats status with no variables", () => {
        const details: SpindleStatusDetails = {
            variables: [],
            usage: { totalCost: 0, totalEpisodes: 0, totalLlmCalls: 0 },
            config: { subModel: undefined, outputLimit: 8192, timeoutMs: 300000 },
        };
        const text = formatStatusResult(details, theme);
        expect(text).toContain("No variables");
        expect(text).toContain("(default)");
    });
});

describe("formatDispatchProgress", () => {
    function makeState(overrides?: Partial<ThreadState>): ThreadState {
        return {
            index: 0, task: "test task", agent: "scout",
            status: "pending", recentTools: [], toolCount: 0,
            startTime: 0, durationMs: 0, cost: 0,
            ...overrides,
        };
    }

    it("shows pending threads", () => {
        const text = formatDispatchProgress([makeState(), makeState({ index: 1 })]);
        expect(text).toContain("2 threads");
        expect(text).toContain("0 done");
        expect(text).toContain("○");
    });

    it("shows running threads with elapsed time", () => {
        const text = formatDispatchProgress([
            makeState({ status: "running", startTime: Date.now() - 5000, agent: "scout" }),
        ]);
        expect(text).toContain("1 running");
        expect(text).toContain("⏳");
        expect(text).toContain("scout");
    });

    it("shows done threads with episode summary", () => {
        const text = formatDispatchProgress([
            makeState({
                status: "done", durationMs: 3000, agent: "worker",
                episode: makeEpisode({ status: "success", summary: "Fixed the bug" }),
            }),
        ]);
        expect(text).toContain("1 done");
        expect(text).toContain("✓");
        expect(text).toContain("Fixed the bug");
    });

    it("shows mixed state", () => {
        const text = formatDispatchProgress([
            makeState({ status: "done", durationMs: 2000, episode: makeEpisode() }),
            makeState({ index: 1, status: "running", startTime: Date.now() - 1000 }),
            makeState({ index: 2, status: "pending" }),
        ]);
        expect(text).toContain("1 done");
        expect(text).toContain("1 running");
        expect(text).toContain("1 pending");
    });
});
