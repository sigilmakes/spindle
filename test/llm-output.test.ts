import { describe, it, expect } from "vitest";
import { truncateLlmOutput, DEFAULT_LLM_MAX_OUTPUT, MIN_LLM_MAX_OUTPUT } from "../src/index.js";

describe("truncateLlmOutput", () => {
    it("passes through short text unchanged", () => {
        const text = "Hello, world!";
        expect(truncateLlmOutput(text, undefined)).toBe(text);
    });

    it("passes through text exactly at the limit", () => {
        const text = "x".repeat(DEFAULT_LLM_MAX_OUTPUT);
        expect(truncateLlmOutput(text, undefined)).toBe(text);
    });

    it("truncates text exceeding the default limit", () => {
        const text = "x".repeat(DEFAULT_LLM_MAX_OUTPUT + 1000);
        const result = truncateLlmOutput(text, undefined);
        expect(result.length).toBeLessThan(text.length);
        expect(result).toContain("truncated");
        expect(result).toContain(`${text.length} total chars`);
        expect(result).toContain("maxOutput: false");
    });

    it("preserves head and tail content", () => {
        const head = "HEAD_MARKER_" + "a".repeat(1000);
        const middle = "m".repeat(DEFAULT_LLM_MAX_OUTPUT);
        const tail = "b".repeat(1000) + "_TAIL_MARKER";
        const text = head + middle + tail;

        const result = truncateLlmOutput(text, undefined);
        expect(result).toContain("HEAD_MARKER_");
        expect(result).toContain("_TAIL_MARKER");
    });

    it("respects a custom maxOutput number", () => {
        // Must exceed MIN_LLM_MAX_OUTPUT to actually set the limit
        const limit = MIN_LLM_MAX_OUTPUT + 500;
        const text = "x".repeat(limit + 1000);
        const result = truncateLlmOutput(text, limit);
        expect(result).toContain("truncated");
        const headSize = Math.floor(limit * 0.7);
        const tailSize = Math.floor(limit * 0.3);
        expect(result).toContain(`first ${headSize}`);
        expect(result).toContain(`last ${tailSize}`);
    });

    it("floors maxOutput at MIN_LLM_MAX_OUTPUT", () => {
        const text = "x".repeat(MIN_LLM_MAX_OUTPUT + 500);
        // Requesting 50 should floor to MIN_LLM_MAX_OUTPUT
        const result = truncateLlmOutput(text, 50);
        expect(result).toContain("truncated");
        const headSize = Math.floor(MIN_LLM_MAX_OUTPUT * 0.7);
        expect(result).toContain(`first ${headSize}`);
    });

    it("returns full text when maxOutput is false (opt-out)", () => {
        const text = "x".repeat(DEFAULT_LLM_MAX_OUTPUT * 2);
        expect(truncateLlmOutput(text, false)).toBe(text);
    });

    it("returns full text when maxOutput is Infinity", () => {
        const text = "x".repeat(DEFAULT_LLM_MAX_OUTPUT * 2);
        // Infinity is not false, so it goes through the numeric path
        // limit = Infinity, text.length <= limit is false for finite, but
        // !Number.isFinite(Infinity) is true, so it returns early
        expect(truncateLlmOutput(text, Infinity as any)).toBe(text);
    });

    it("uses defaultMax parameter when max is undefined", () => {
        // defaultMax is also floored at MIN_LLM_MAX_OUTPUT
        const text = "x".repeat(MIN_LLM_MAX_OUTPUT + 500);
        const result = truncateLlmOutput(text, undefined, MIN_LLM_MAX_OUTPUT + 100);
        expect(result).toContain("truncated");

        // With defaultMax larger than text, passes through
        const result2 = truncateLlmOutput(text, undefined, MIN_LLM_MAX_OUTPUT + 1000);
        expect(result2).toBe(text);
    });

    it("handles empty string", () => {
        expect(truncateLlmOutput("", undefined)).toBe("");
        expect(truncateLlmOutput("", 10)).toBe("");
        expect(truncateLlmOutput("", false)).toBe("");
    });

    it("head+tail do not overlap for reasonable limits", () => {
        const limit = MIN_LLM_MAX_OUTPUT + 500;
        const text = "x".repeat(limit + 1000);
        const result = truncateLlmOutput(text, limit);
        const headSize = Math.floor(limit * 0.7);
        const tailSize = Math.floor(limit * 0.3);
        expect(result.startsWith("x".repeat(headSize))).toBe(true);
        expect(result.endsWith("x".repeat(tailSize))).toBe(true);
    });

    it("DEFAULT_LLM_MAX_OUTPUT is 50KB", () => {
        expect(DEFAULT_LLM_MAX_OUTPUT).toBe(50 * 1024);
    });

    it("truncation marker includes total char count", () => {
        const text = "a".repeat(MIN_LLM_MAX_OUTPUT + 500);
        const result = truncateLlmOutput(text, MIN_LLM_MAX_OUTPUT + 100);
        expect(result).toContain(`${text.length} total chars`);
    });
});
