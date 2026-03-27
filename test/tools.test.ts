import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
    load, save, createFileIO,
    createToolWrappers, ToolResult,
} from "../src/tools.js";

describe("load", () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-test-")); });
    afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    it("loads a single file", async () => {
        fs.writeFileSync(path.join(tmp, "f.txt"), "hello");
        const r = await load("f.txt", tmp);
        expect(r.content).toBe("hello");
        expect(r.metadata.type).toBe("file");
        expect(r.metadata.fileCount).toBe(1);
    });

    it("loads a directory as a Map", async () => {
        fs.mkdirSync(path.join(tmp, "d"));
        fs.writeFileSync(path.join(tmp, "d", "a.txt"), "aaa");
        fs.writeFileSync(path.join(tmp, "d", "b.txt"), "bbb");
        const r = await load("d", tmp);
        expect(r.metadata.type).toBe("directory");
        expect(r.content).toBeInstanceOf(Map);
        const m = r.content as Map<string, string>;
        expect(m.size).toBe(2);
        expect(m.get("a.txt")).toBe("aaa");
    });

    it("throws on too-large file", async () => {
        const big = path.join(tmp, "big.txt");
        fs.writeFileSync(big, "x".repeat(100));
        await expect(load("big.txt", tmp, 50)).rejects.toThrow("too large");
    });

    it("throws on nonexistent path", async () => {
        await expect(load("nope.txt", tmp)).rejects.toThrow();
    });

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
