import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
    load, save, createFileIO,
    FileConflictError, guardedWrite,
    createMtimeGuardedEditOperations, getMtimeMap,
    createToolWrappers, ToolResult,
} from "../src/tools.js";
import { acquireLock, releaseLock, checkLock, FileLockError } from "../src/locks.js";

describe("load", () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-test-")); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it("loads a text file", async () => {
        fs.writeFileSync(path.join(tmp, "f.txt"), "hello");
        const r = await load("f.txt", tmp);
        expect(r.content).toBe("hello");
        expect(r.metadata.type).toBe("file");
        expect(r.metadata.fileCount).toBe(1);
    });

    it("loads a directory as a Map", async () => {
        fs.mkdirSync(path.join(tmp, "src"));
        fs.writeFileSync(path.join(tmp, "src", "a.ts"), "a");
        fs.writeFileSync(path.join(tmp, "src", "b.ts"), "b");
        const r = await load("src", tmp);
        const m = r.content as Map<string, string>;
        expect(m).toBeInstanceOf(Map);
        expect(m.size).toBe(2);
        expect(m.get("a.ts")).toBe("a");
        expect(m.get("b.ts")).toBe("b");
        expect(r.metadata.type).toBe("directory");
    });

    it("skips node_modules", async () => {
        fs.mkdirSync(path.join(tmp, "d"));
        fs.writeFileSync(path.join(tmp, "d", "app.ts"), "app");
        fs.mkdirSync(path.join(tmp, "d", "node_modules"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "d", "node_modules", "x.js"), "x");
        const m = (await load("d", tmp)).content as Map<string, string>;
        expect(m.size).toBe(1);
        expect(m.has("app.ts")).toBe(true);
    });

    it("skips .git and hidden files", async () => {
        fs.mkdirSync(path.join(tmp, "p"));
        fs.writeFileSync(path.join(tmp, "p", "main.ts"), "main");
        fs.mkdirSync(path.join(tmp, "p", ".git"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "p", ".git", "config"), "c");
        fs.writeFileSync(path.join(tmp, "p", ".hidden"), "h");
        const m = (await load("p", tmp)).content as Map<string, string>;
        expect(m.size).toBe(1);
        expect(m.has("main.ts")).toBe(true);
    });

    it("loads nested directories", async () => {
        fs.mkdirSync(path.join(tmp, "a", "b", "c"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "a", "top.ts"), "top");
        fs.writeFileSync(path.join(tmp, "a", "b", "mid.ts"), "mid");
        fs.writeFileSync(path.join(tmp, "a", "b", "c", "deep.ts"), "deep");
        const m = (await load("a", tmp)).content as Map<string, string>;
        expect(m.size).toBe(3);
        expect(m.get("b/c/deep.ts")).toBe("deep");
    });

    it("throws on files exceeding max size", async () => {
        fs.writeFileSync(path.join(tmp, "big.txt"), "x".repeat(200));
        await expect(load("big.txt", tmp, 100)).rejects.toThrow("File too large");
    });

    it("throws on non-existent path", async () => {
        await expect(load("nope.txt", tmp)).rejects.toThrow();
    });
});

describe("save", () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-test-")); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it("writes a file", async () => {
        await save("out.txt", "hello", tmp);
        expect(fs.readFileSync(path.join(tmp, "out.txt"), "utf-8")).toBe("hello");
    });

    it("creates parent directories", async () => {
        await save("a/b/out.txt", "nested", tmp);
        expect(fs.readFileSync(path.join(tmp, "a", "b", "out.txt"), "utf-8")).toBe("nested");
    });

    it("overwrites existing files", async () => {
        fs.writeFileSync(path.join(tmp, "f.txt"), "old");
        await save("f.txt", "new", tmp);
        expect(fs.readFileSync(path.join(tmp, "f.txt"), "utf-8")).toBe("new");
    });
});

describe("createFileIO", () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-test-")); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it("returns bound load/save that work together", async () => {
        const io = createFileIO(tmp);
        await io.save("test.txt", "hello");
        expect(await io.load("test.txt")).toBe("hello");
    });

    it("load returns Map for directories", async () => {
        const io = createFileIO(tmp);
        fs.mkdirSync(path.join(tmp, "src"));
        await io.save("src/a.ts", "a");
        await io.save("src/b.ts", "b");
        const m = await io.load("src") as Map<string, string>;
        expect(m).toBeInstanceOf(Map);
        expect(m.size).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// W1A: Optimistic concurrency tests
// ---------------------------------------------------------------------------

describe("FileConflictError", () => {
    it("has correct properties", () => {
        const err = new FileConflictError("/tmp/test.txt", 1000, 2000);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(FileConflictError);
        expect(err.name).toBe("FileConflictError");
        expect(err.path).toBe("/tmp/test.txt");
        expect(err.expectedMtime).toBe(1000);
        expect(err.actualMtime).toBe(2000);
        expect(err.message).toContain("File modified since read");
        expect(err.message).toContain("/tmp/test.txt");
    });
});

describe("guardedWrite", () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-gw-")); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it("writes unconditionally without expectedMtimeMs", () => {
        const f = path.join(tmp, "a.txt");
        guardedWrite(f, "hello");
        expect(fs.readFileSync(f, "utf-8")).toBe("hello");
    });

    it("writes when mtime matches", () => {
        const f = path.join(tmp, "b.txt");
        fs.writeFileSync(f, "v1");
        const mtime = fs.statSync(f).mtimeMs;
        guardedWrite(f, "v2", mtime);
        expect(fs.readFileSync(f, "utf-8")).toBe("v2");
    });

    it("throws FileConflictError when mtime mismatches", () => {
        const f = path.join(tmp, "c.txt");
        fs.writeFileSync(f, "v1");
        const mtime = fs.statSync(f).mtimeMs;
        // Externally modify the file to change its mtime
        const later = mtime + 1000;
        fs.utimesSync(f, new Date(later), new Date(later));
        expect(() => guardedWrite(f, "v2", mtime)).toThrow(FileConflictError);
    });

    it("writes new file even with expectedMtimeMs (file doesn't exist)", () => {
        const f = path.join(tmp, "new.txt");
        // Pass a stale mtime, but file doesn't exist — should still write
        guardedWrite(f, "fresh", 99999);
        expect(fs.readFileSync(f, "utf-8")).toBe("fresh");
    });
});

describe("mtime-guarded EditOperations", () => {
    let tmp: string;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-edit-"));
        getMtimeMap().clear();
    });
    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        getMtimeMap().clear();
    });

    it("readFile stashes mtime in the map", async () => {
        const f = path.join(tmp, "r.txt");
        fs.writeFileSync(f, "data");
        const expectedMtime = fs.statSync(f).mtimeMs;

        const ops = createMtimeGuardedEditOperations();
        const buf = await ops.readFile(f);
        expect(buf.toString("utf-8")).toBe("data");
        expect(getMtimeMap().get(f)).toBe(expectedMtime);
    });

    it("writeFile succeeds when file unchanged", async () => {
        const f = path.join(tmp, "w.txt");
        fs.writeFileSync(f, "original");

        const ops = createMtimeGuardedEditOperations();
        await ops.readFile(f); // stash mtime
        await ops.writeFile(f, "updated"); // should succeed
        expect(fs.readFileSync(f, "utf-8")).toBe("updated");
    });

    it("writeFile detects concurrent modification", async () => {
        const f = path.join(tmp, "conflict.txt");
        fs.writeFileSync(f, "v1");

        const ops = createMtimeGuardedEditOperations();
        await ops.readFile(f); // stash mtime

        // Externally modify the file
        const stat = fs.statSync(f);
        const later = stat.mtimeMs + 2000;
        fs.utimesSync(f, new Date(later), new Date(later));

        await expect(ops.writeFile(f, "v2")).rejects.toThrow(FileConflictError);
        // File should still have old content
        expect(fs.readFileSync(f, "utf-8")).toBe("v1");
    });

    it("sequential edits to same file work", async () => {
        const f = path.join(tmp, "seq.txt");
        fs.writeFileSync(f, "v1");

        const ops = createMtimeGuardedEditOperations();
        await ops.readFile(f);
        await ops.writeFile(f, "v2"); // updates mtime in map

        // Read again → new mtime
        await ops.readFile(f);
        await ops.writeFile(f, "v3"); // should also succeed
        expect(fs.readFileSync(f, "utf-8")).toBe("v3");
    });

    it("mtime map is per-path", async () => {
        const f1 = path.join(tmp, "a.txt");
        const f2 = path.join(tmp, "b.txt");
        fs.writeFileSync(f1, "a");
        fs.writeFileSync(f2, "b");

        const ops = createMtimeGuardedEditOperations();
        await ops.readFile(f1);
        await ops.readFile(f2);

        // Externally modify f1
        const stat = fs.statSync(f1);
        fs.utimesSync(f1, new Date(stat.mtimeMs + 2000), new Date(stat.mtimeMs + 2000));

        // f2 should still be writable
        await ops.writeFile(f2, "b-updated");
        expect(fs.readFileSync(f2, "utf-8")).toBe("b-updated");

        // f1 should conflict
        await expect(ops.writeFile(f1, "a-updated")).rejects.toThrow(FileConflictError);
    });

    it("writeFile without prior read skips guard", async () => {
        const f = path.join(tmp, "noread.txt");
        fs.writeFileSync(f, "original");

        const ops = createMtimeGuardedEditOperations();
        // No readFile call — no mtime stashed
        await ops.writeFile(f, "overwritten");
        expect(fs.readFileSync(f, "utf-8")).toBe("overwritten");
    });
});

describe("load metadata.mtimeMs", () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-mtime-")); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it("returns mtimeMs for single files", async () => {
        const f = path.join(tmp, "f.txt");
        fs.writeFileSync(f, "content");
        const expected = fs.statSync(f).mtimeMs;

        const r = await load("f.txt", tmp);
        expect(r.metadata.mtimeMs).toBe(expected);
    });

    it("does not return mtimeMs for directories", async () => {
        fs.mkdirSync(path.join(tmp, "d"));
        fs.writeFileSync(path.join(tmp, "d", "x.txt"), "x");
        const r = await load("d", tmp);
        expect(r.metadata.mtimeMs).toBeUndefined();
    });
});

describe("save with mtime guard", () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-save-")); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it("detects mtime mismatch when mtimeMs provided", async () => {
        const f = path.join(tmp, "guarded.txt");
        fs.writeFileSync(f, "v1");
        const r = await load("guarded.txt", tmp);
        const mtime = r.metadata.mtimeMs!;

        // Externally modify the file
        fs.utimesSync(f, new Date(mtime + 2000), new Date(mtime + 2000));

        await expect(save("guarded.txt", "v2", tmp, mtime)).rejects.toThrow(FileConflictError);
    });

    it("writes unconditionally without mtimeMs", async () => {
        fs.writeFileSync(path.join(tmp, "plain.txt"), "v1");
        await save("plain.txt", "v2", tmp);
        expect(fs.readFileSync(path.join(tmp, "plain.txt"), "utf-8")).toBe("v2");
    });

    it("writes successfully when mtime matches", async () => {
        fs.writeFileSync(path.join(tmp, "match.txt"), "v1");
        const r = await load("match.txt", tmp);
        const mtime = r.metadata.mtimeMs!;

        await save("match.txt", "v2", tmp, mtime);
        expect(fs.readFileSync(path.join(tmp, "match.txt"), "utf-8")).toBe("v2");
    });
});

describe("file locking integration", () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-lock-int-")); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it("save acquires and releases file lock", async () => {
        const f = path.join(tmp, "locked.txt");
        fs.writeFileSync(f, "v1");

        await save("locked.txt", "v2", tmp);

        // Lock should be released after save
        expect(checkLock(f)).toBeNull();
        expect(fs.readFileSync(f, "utf-8")).toBe("v2");
    });

    it("save waits for lock held by same process", async () => {
        const f = path.join(tmp, "busy.txt");
        fs.writeFileSync(f, "v1");

        // Hold a lock, release it after 50ms
        acquireLock(f);
        setTimeout(() => releaseLock(f), 50);

        // save should wait and succeed (timeout is 10s)
        await save("busy.txt", "v2", tmp);
        expect(fs.readFileSync(f, "utf-8")).toBe("v2");
    });

    it("save cleans up lock even on error", async () => {
        const f = path.join(tmp, "fail.txt");
        fs.writeFileSync(f, "v1");
        const r = await load("fail.txt", tmp);
        const mtime = r.metadata.mtimeMs!;

        // Change mtime to force a FileConflictError inside the lock
        fs.utimesSync(f, new Date(mtime + 2000), new Date(mtime + 2000));

        await expect(save("fail.txt", "v2", tmp, mtime)).rejects.toThrow(FileConflictError);

        // Lock should still be released
        expect(checkLock(f)).toBeNull();
    });
});

describe("ToolResult", () => {
    it("success creates ok result", () => {
        const r = ToolResult.success("hello");
        expect(r.output).toBe("hello");
        expect(r.error).toBe("");
        expect(r.ok).toBe(true);
        expect(r.exitCode).toBe(0);
    });

    it("fail creates error result", () => {
        const r = ToolResult.fail("something broke");
        expect(r.output).toBe("");
        expect(r.error).toBe("something broke");
        expect(r.ok).toBe(false);
        expect(r.exitCode).toBe(1);
    });

    it("fail preserves output", () => {
        const r = ToolResult.fail("partial error", "some output");
        expect(r.output).toBe("some output");
        expect(r.error).toBe("partial error");
        expect(r.ok).toBe(false);
    });

    it("toString returns output", () => {
        const r = ToolResult.success("file content");
        expect(`${r}`).toBe("file content");
        expect(String(r)).toBe("file content");
    });

    it("toJSON returns output", () => {
        const r = ToolResult.success("data");
        expect(JSON.stringify(r)).toBe('"data"');
    });
});

describe("tool wrappers return ToolResult", () => {
    let tmp: string;
    let wrappers: ReturnType<typeof createToolWrappers>;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-wrappers-"));
        wrappers = createToolWrappers(tmp);
    });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it("bash returns ToolResult with stdout", async () => {
        const r = await wrappers.bash({ command: "echo hello" });
        expect(r).toBeInstanceOf(ToolResult);
        expect(r.ok).toBe(true);
        expect(r.output.trim()).toBe("hello");
        expect(r.exitCode).toBe(0);
    });

    it("bash returns ToolResult on failure without throwing", async () => {
        const r = await wrappers.bash({ command: "exit 42" });
        expect(r).toBeInstanceOf(ToolResult);
        expect(r.ok).toBe(false);
        expect(r.exitCode).toBe(42);
    });

    it("bash captures stderr separately", async () => {
        const r = await wrappers.bash({ command: "echo out; echo err >&2" });
        expect(r.output.trim()).toBe("out");
        expect(r.error.trim()).toBe("err");
    });

    it("read returns ToolResult", async () => {
        fs.writeFileSync(path.join(tmp, "test.txt"), "content");
        const r = await wrappers.read({ path: "test.txt" });
        expect(r).toBeInstanceOf(ToolResult);
        expect(r.ok).toBe(true);
        expect(r.output).toContain("content");
    });

    it("read returns error ToolResult for missing file", async () => {
        const r = await wrappers.read({ path: "nope.txt" });
        expect(r).toBeInstanceOf(ToolResult);
        expect(r.ok).toBe(false);
        expect(r.error).toContain("nope.txt");
    });

    it("edit returns ToolResult", async () => {
        fs.writeFileSync(path.join(tmp, "e.txt"), "old text");
        const r = await wrappers.edit({ path: "e.txt", oldText: "old", newText: "new" });
        expect(r).toBeInstanceOf(ToolResult);
        expect(r.ok).toBe(true);
        expect(fs.readFileSync(path.join(tmp, "e.txt"), "utf-8")).toBe("new text");
    });

    it("edit returns error ToolResult on mismatch", async () => {
        fs.writeFileSync(path.join(tmp, "e2.txt"), "actual content");
        const r = await wrappers.edit({ path: "e2.txt", oldText: "nonexistent", newText: "new" });
        expect(r).toBeInstanceOf(ToolResult);
        expect(r.ok).toBe(false);
        expect(r.error.length).toBeGreaterThan(0);
    });

    it("write returns ToolResult", async () => {
        const r = await wrappers.write({ path: "w.txt", content: "written" });
        expect(r).toBeInstanceOf(ToolResult);
        expect(r.ok).toBe(true);
        expect(fs.readFileSync(path.join(tmp, "w.txt"), "utf-8")).toBe("written");
    });
});
