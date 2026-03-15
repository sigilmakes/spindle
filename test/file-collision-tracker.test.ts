import { describe, it, expect } from "vitest";
import { FileCollisionTracker, extractWritePaths } from "../src/file-collision-tracker.js";

describe("FileCollisionTracker", () => {
    it("returns null when a file is written by a single thread", () => {
        const tracker = new FileCollisionTracker();
        expect(tracker.recordWrite(0, "/tmp/a.ts")).toBeNull();
        expect(tracker.recordWrite(1, "/tmp/b.ts")).toBeNull();
        expect(tracker.warnings).toHaveLength(0);
    });

    it("detects collision when two threads write the same file", () => {
        const tracker = new FileCollisionTracker();
        expect(tracker.recordWrite(0, "/tmp/a.ts")).toBeNull();
        const warning = tracker.recordWrite(2, "/tmp/a.ts");
        expect(warning).not.toBeNull();
        expect(warning).toContain("a.ts");
        expect(warning).toContain("0");
        expect(warning).toContain("2");
    });

    it("accumulates warnings", () => {
        const tracker = new FileCollisionTracker();
        tracker.recordWrite(0, "/tmp/a.ts");
        tracker.recordWrite(1, "/tmp/a.ts");
        expect(tracker.warnings).toHaveLength(1);
        expect(tracker.warnings[0]).toContain("a.ts");
    });

    it("detects collision among three threads", () => {
        const tracker = new FileCollisionTracker();
        tracker.recordWrite(0, "/tmp/a.ts");
        const w1 = tracker.recordWrite(1, "/tmp/a.ts");
        expect(w1).toContain("0, 1");
        const w2 = tracker.recordWrite(3, "/tmp/a.ts");
        expect(w2).toContain("0, 1, 3");
        expect(tracker.warnings).toHaveLength(2);
    });

    it("does not warn when the same thread writes the same file twice", () => {
        const tracker = new FileCollisionTracker();
        expect(tracker.recordWrite(0, "/tmp/a.ts")).toBeNull();
        expect(tracker.recordWrite(0, "/tmp/a.ts")).toBeNull();
        expect(tracker.warnings).toHaveLength(0);
    });

    it("tracks different files independently", () => {
        const tracker = new FileCollisionTracker();
        tracker.recordWrite(0, "/tmp/a.ts");
        tracker.recordWrite(1, "/tmp/b.ts");
        expect(tracker.warnings).toHaveLength(0);
    });

    it("resolves relative paths against cwd", () => {
        const tracker = new FileCollisionTracker();
        // Both should resolve to the same absolute path
        tracker.recordWrite(0, "src/app.ts", "/home/user/project");
        const warning = tracker.recordWrite(1, "/home/user/project/src/app.ts");
        expect(warning).not.toBeNull();
        expect(warning).toContain("app.ts");
    });

    it("getWriters returns thread indices for a path", () => {
        const tracker = new FileCollisionTracker();
        tracker.recordWrite(0, "/tmp/a.ts");
        tracker.recordWrite(2, "/tmp/a.ts");
        expect(tracker.getWriters("/tmp/a.ts")).toEqual([0, 2]);
    });

    it("getWriters returns empty for untracked path", () => {
        const tracker = new FileCollisionTracker();
        expect(tracker.getWriters("/tmp/unknown.ts")).toEqual([]);
    });
});

describe("extractWritePaths", () => {
    it("extracts path from write tool", () => {
        expect(extractWritePaths("write", { path: "src/app.ts", content: "..." })).toEqual(["src/app.ts"]);
    });

    it("extracts path from edit tool", () => {
        expect(extractWritePaths("edit", { path: "src/app.ts", oldText: "a", newText: "b" })).toEqual(["src/app.ts"]);
    });

    it("extracts file_path as fallback", () => {
        expect(extractWritePaths("edit", { file_path: "src/app.ts" })).toEqual(["src/app.ts"]);
    });

    it("extracts paths from multi-edit", () => {
        const args = {
            multi: [
                { path: "src/a.ts", oldText: "x", newText: "y" },
                { path: "src/b.ts", oldText: "x", newText: "y" },
            ],
        };
        expect(extractWritePaths("edit", args)).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("extracts both single path and multi paths", () => {
        const args = {
            path: "src/main.ts",
            multi: [
                { path: "src/a.ts", oldText: "x", newText: "y" },
            ],
        };
        expect(extractWritePaths("edit", args)).toEqual(["src/main.ts", "src/a.ts"]);
    });

    it("returns empty for non-write tools", () => {
        expect(extractWritePaths("read", { path: "src/app.ts" })).toEqual([]);
        expect(extractWritePaths("bash", { command: "ls" })).toEqual([]);
        expect(extractWritePaths("grep", { pattern: "TODO" })).toEqual([]);
    });

    it("returns empty when no path is present", () => {
        expect(extractWritePaths("edit", {})).toEqual([]);
        expect(extractWritePaths("write", {})).toEqual([]);
    });

    it("handles malformed multi array gracefully", () => {
        expect(extractWritePaths("edit", { multi: [null, 42, { noPath: true }] })).toEqual([]);
        expect(extractWritePaths("edit", { multi: "not-array" })).toEqual([]);
    });
});
