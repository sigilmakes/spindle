import { describe, it, expect } from "vitest";
import {
    formatCodeForDisplay,
    formatExecResult,
    formatStatusResult,
    type SpindleExecDetails,
    type SpindleStatusDetails,
} from "../src/render.js";

// Minimal theme stub for testing
const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as any;

describe("formatCodeForDisplay", () => {
    it("formats short code", () => {
        const result = formatCodeForDisplay('console.log("hi")', theme);
        expect(result).toContain("spindle_exec");
        expect(result).toContain('console.log("hi")');
    });

    it("truncates long code", () => {
        const lines = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
        const result = formatCodeForDisplay(lines, theme, 15);
        expect(result).toContain("15 more lines");
        expect(result).toContain("line0");
        expect(result).not.toContain("line20");
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

    it("formats episodes", () => {
        const result = {
            content: [{ type: "text" as const, text: "" }],
            details: {
                code: "dispatch([...])",
                durationMs: 5000,
                error: false,
                episodes: [{
                    status: "success" as const,
                    summary: "Found 3 issues",
                    findings: ["issue A", "issue B"],
                    artifacts: [], blockers: [],
                    toolCalls: 5, raw: "", task: "audit", agent: "scout",
                    model: "test", cost: 0.02, duration: 3000,
                }],
            } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, true, theme);
        expect(text).toContain("Episodes");
        expect(text).toContain("scout");
        expect(text).toContain("Found 3 issues");
        expect(text).toContain("issue A");
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
