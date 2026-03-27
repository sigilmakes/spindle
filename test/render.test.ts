import { describe, it, expect } from "vitest";
import {
    formatCodeForDisplay,
    formatExecResult,
    formatStatusResult,
    type SpindleExecDetails,
    type SpindleStatusDetails,
} from "../src/render.js";

const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as any;

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
    it("formats successful result with output", () => {
        const result = {
            content: [{ type: "text" as const, text: "output here" }],
            details: { code: "x = 1", durationMs: 150, error: false } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("output here");
    });

    it("formats error result", () => {
        const result = {
            content: [{ type: "text" as const, text: "Error: boom" }],
            details: { code: "bad()", durationMs: 50, error: true } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("Error: boom");
    });

    it("shows duration for slow results", () => {
        const result = {
            content: [{ type: "text" as const, text: "done" }],
            details: { code: "x", durationMs: 5000, error: false } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toContain("5.0s");
    });

    it("hides duration for fast results", () => {
        const result = {
            content: [{ type: "text" as const, text: "done" }],
            details: { code: "x", durationMs: 500, error: false } satisfies SpindleExecDetails,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).not.toContain("0.5s");
    });

    it("handles missing details", () => {
        const result = {
            content: [{ type: "text" as const, text: "raw output" }],
            details: undefined as any,
        };
        const text = formatExecResult(result, false, theme);
        expect(text).toBe("raw output");
    });
});

describe("formatStatusResult", () => {
    it("formats status with variables", () => {
        const details: SpindleStatusDetails = {
            variables: [
                { name: "x", type: "number", preview: "42" },
                { name: "data", type: "object", preview: "{a, b}" },
            ],
            usage: { totalCost: 0.05, totalLlmCalls: 3 },
            config: { subModel: "haiku", outputLimit: 8192 },
        };
        const text = formatStatusResult(details, theme);
        expect(text).toContain("x");
        expect(text).toContain("42");
        expect(text).toContain("data");
        expect(text).toContain("3 sub-agent calls");
        expect(text).toContain("haiku");
    });

    it("formats status with no variables", () => {
        const details: SpindleStatusDetails = {
            variables: [],
            usage: { totalCost: 0, totalLlmCalls: 0 },
            config: { subModel: undefined, outputLimit: 8192 },
        };
        const text = formatStatusResult(details, theme);
        expect(text).toContain("(none)");
        expect(text).toContain("(default)");
    });
});
