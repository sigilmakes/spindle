import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { load, save, createFileIO } from "../src/tools.js";

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
