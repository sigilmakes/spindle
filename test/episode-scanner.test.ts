import { describe, it, expect } from "vitest";
import { EpisodeScanner } from "../src/episode-scanner.js";

describe("EpisodeScanner", () => {
    it("finds a complete episode block in a single append", () => {
        const scanner = new EpisodeScanner();
        const blocks = scanner.append("hello\n<episode>\nstatus: success\n</episode>\n");
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toBe("<episode>\nstatus: success\n</episode>");
    });

    it("returns empty when no episode block present", () => {
        const scanner = new EpisodeScanner();
        expect(scanner.append("just some text")).toEqual([]);
        expect(scanner.append("more text")).toEqual([]);
    });

    it("finds multiple blocks across appends", () => {
        const scanner = new EpisodeScanner();

        const b1 = scanner.append("text\n<episode>first</episode>\nmore");
        expect(b1).toHaveLength(1);
        expect(b1[0]).toBe("<episode>first</episode>");

        const b2 = scanner.append("\n<episode>second</episode>\nend");
        expect(b2).toHaveLength(1);
        expect(b2[0]).toBe("<episode>second</episode>");
    });

    it("finds multiple blocks in a single append", () => {
        const scanner = new EpisodeScanner();
        const blocks = scanner.append("<episode>a</episode>gap<episode>b</episode>");
        expect(blocks).toHaveLength(2);
        expect(blocks[0]).toBe("<episode>a</episode>");
        expect(blocks[1]).toBe("<episode>b</episode>");
    });

    it("does not re-emit previously found blocks", () => {
        const scanner = new EpisodeScanner();

        const b1 = scanner.append("<episode>one</episode>");
        expect(b1).toHaveLength(1);

        // Append more text with no new blocks
        const b2 = scanner.append(" trailing text");
        expect(b2).toEqual([]);
    });

    it("handles closing tag split across two appends", () => {
        const scanner = new EpisodeScanner();

        // First chunk: complete opening + content + partial closing tag
        const b1 = scanner.append("<episode>content</epis");
        expect(b1).toEqual([]);

        // Second chunk: rest of closing tag
        const b2 = scanner.append("ode>");
        expect(b2).toHaveLength(1);
        expect(b2[0]).toBe("<episode>content</episode>");
    });

    it("handles opening tag split across two appends", () => {
        const scanner = new EpisodeScanner();

        // Opening tag split — this is beyond the 10-char overlap but
        // should still work since the full block completes in the new scan region
        const b1 = scanner.append("prefix<epi");
        expect(b1).toEqual([]);

        const b2 = scanner.append("sode>body</episode>suffix");
        // The opening "<episode>" starts at position 6 in the buffer.
        // scanOffset after first append is 10.
        // searchFrom = max(0, 10 - 10) = 0 — scans from start.
        // The full block is found.
        expect(b2).toHaveLength(1);
        expect(b2[0]).toBe("<episode>body</episode>");
    });

    it("accumulates full text via .text getter", () => {
        const scanner = new EpisodeScanner();
        scanner.append("hello ");
        scanner.append("world");
        expect(scanner.text).toBe("hello world");
    });

    it("handles empty appends", () => {
        const scanner = new EpisodeScanner();
        expect(scanner.append("")).toEqual([]);
        scanner.append("<episode>x</episode>");
        expect(scanner.append("")).toEqual([]);
    });

    it("stress: many appends without quadratic blowup", () => {
        const scanner = new EpisodeScanner();
        // Simulate 500 turns of ~1KB each (total ~500KB)
        // With the old approach this would scan 500KB × 500 = 250MB of regex work
        for (let i = 0; i < 500; i++) {
            const chunk = `Turn ${i}: ${"x".repeat(1000)}\n`;
            scanner.append(chunk);
        }
        // Final turn has the episode block
        const blocks = scanner.append("\n<episode>\nstatus: success\nsummary: done\n</episode>\n");
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toContain("status: success");
        expect(scanner.text.length).toBeGreaterThan(500 * 1000);
    });

    it("handles multiline episode content with special chars", () => {
        const scanner = new EpisodeScanner();
        const episode = `<episode>
status: success
summary: Did stuff with \`code\` and **bold**
findings:
- Found "thing" in /path/to/file.ts
- Used regex /pattern/g
artifacts:
- src/foo.ts — created
</episode>`;
        const blocks = scanner.append(`Some preamble\n${episode}\n`);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toBe(episode);
    });

    it("correctly handles block at very end of text with no trailing content", () => {
        const scanner = new EpisodeScanner();
        scanner.append("lots of work output here\n");
        const blocks = scanner.append("<episode>done</episode>");
        expect(blocks).toHaveLength(1);
    });

    it("does not match nested or malformed tags", () => {
        const scanner = new EpisodeScanner();
        // Partial opening without closing
        const b1 = scanner.append("<episode>no close");
        expect(b1).toEqual([]);
        // Now close it
        const b2 = scanner.append("</episode>");
        expect(b2).toHaveLength(1);
        expect(b2[0]).toBe("<episode>no close</episode>");
    });
});
