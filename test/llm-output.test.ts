import { describe, it, expect } from "vitest";
import { truncateLlmOutput, DEFAULT_LLM_MAX_OUTPUT } from "../src/index.js";

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
        const text = "x".repeat(500);
        const result = truncateLlmOutput(text, 200);
        expect(result).toContain("truncated");
        // Head should be ~140 chars (70% of 200), tail ~60 chars (30% of 200)
        const headSize = Math.floor(200 * 0.7);
        const tailSize = Math.floor(200 * 0.3);
        expect(result).toContain(`first ${headSize}`);
        expect(result).toContain(`last ${tailSize}`);
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
        const text = "x".repeat(200);
        // With a custom defaultMax of 100, text should be truncated
        const result = truncateLlmOutput(text, undefined, 100);
        expect(result).toContain("truncated");

        // With a custom defaultMax of 300, text should pass through
        const result2 = truncateLlmOutput(text, undefined, 300);
        expect(result2).toBe(text);
    });

    it("handles empty string", () => {
        expect(truncateLlmOutput("", undefined)).toBe("");
        expect(truncateLlmOutput("", 10)).toBe("");
        expect(truncateLlmOutput("", false)).toBe("");
    });

    it("head+tail do not overlap for reasonable limits", () => {
        const text = "x".repeat(1000);
        const result = truncateLlmOutput(text, 100);
        const headSize = Math.floor(100 * 0.7); // 70
        const tailSize = Math.floor(100 * 0.3); // 30
        // Head portion should be first 70 chars of original
        expect(result.startsWith("x".repeat(headSize))).toBe(true);
        // Tail portion should be last 30 chars of original
        expect(result.endsWith("x".repeat(tailSize))).toBe(true);
    });

    it("DEFAULT_LLM_MAX_OUTPUT is 50KB", () => {
        expect(DEFAULT_LLM_MAX_OUTPUT).toBe(50 * 1024);
    });

    it("truncation marker includes total char count", () => {
        const text = "a".repeat(100);
        const result = truncateLlmOutput(text, 50);
        expect(result).toContain("100 total chars");
    });
});
