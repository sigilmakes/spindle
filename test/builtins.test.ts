import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Repl } from "../src/repl.js";
import { createDiff, retry, createContextTools } from "../src/builtins.js";

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

describe("diff", () => {
    const cwd = process.cwd();
    const diff = createDiff(cwd);

    it("returns empty string for identical inputs", () => {
        expect(diff("hello\nworld\n", "hello\nworld\n")).toBe("");
    });

    it("returns unified diff for different strings", () => {
        const result = diff("line1\nline2\nline3\n", "line1\nchanged\nline3\n");
        expect(result).toContain("-line2");
        expect(result).toContain("+changed");
        expect(result).toContain("@@");
    });

    it("reads files when paths are provided", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-diff-test-"));
        const fileA = path.join(tmpDir, "a.txt");
        const fileB = path.join(tmpDir, "b.txt");

        try {
            fs.writeFileSync(fileA, "alpha\nbeta\n");
            fs.writeFileSync(fileB, "alpha\ngamma\n");

            const diffFn = createDiff(tmpDir);
            const result = diffFn("a.txt", "b.txt");
            expect(result).toContain("-beta");
            expect(result).toContain("+gamma");
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("returns empty string for identical files", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-diff-test-"));
        const fileA = path.join(tmpDir, "a.txt");
        const fileB = path.join(tmpDir, "b.txt");

        try {
            fs.writeFileSync(fileA, "same content\n");
            fs.writeFileSync(fileB, "same content\n");

            const diffFn = createDiff(tmpDir);
            expect(diffFn("a.txt", "b.txt")).toBe("");
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("respects context option", () => {
        const a = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
        const b = "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n10\n";

        const result0 = diff(a, b, { context: 0 });
        const result5 = diff(a, b, { context: 5 });

        // context=0 should be shorter than context=5
        expect(result0.length).toBeLessThan(result5.length);
        // Both should contain the change
        expect(result0).toContain("-5");
        expect(result0).toContain("+FIVE");
    });
});

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

describe("retry", () => {
    it("succeeds on first attempt", async () => {
        const result = await retry(async () => 42);
        expect(result).toBe(42);
    });

    it("retries on failure and eventually succeeds", async () => {
        let calls = 0;
        const result = await retry(
            async () => {
                calls++;
                if (calls < 3) throw new Error("not yet");
                return "ok";
            },
            { attempts: 5, delay: 10, backoff: 1 },
        );
        expect(result).toBe("ok");
        expect(calls).toBe(3);
    });

    it("throws after max attempts", async () => {
        let calls = 0;
        await expect(
            retry(
                async () => {
                    calls++;
                    throw new Error(`fail-${calls}`);
                },
                { attempts: 3, delay: 10, backoff: 1 },
            ),
        ).rejects.toThrow("fail-3");
        expect(calls).toBe(3);
    });

    it("calls onError for each failure", async () => {
        const errors: Array<{ msg: string; attempt: number }> = [];
        let calls = 0;

        await retry(
            async () => {
                calls++;
                if (calls < 3) throw new Error(`err-${calls}`);
                return "done";
            },
            {
                attempts: 3,
                delay: 10,
                backoff: 1,
                onError: (err, attempt) => {
                    errors.push({ msg: (err as Error).message, attempt });
                },
            },
        );

        expect(errors).toEqual([
            { msg: "err-1", attempt: 1 },
            { msg: "err-2", attempt: 2 },
        ]);
    });

    it("uses exponential backoff (check timing roughly)", async () => {
        let calls = 0;
        const start = Date.now();

        await expect(
            retry(
                async () => {
                    calls++;
                    throw new Error("fail");
                },
                { attempts: 3, delay: 50, backoff: 2 },
            ),
        ).rejects.toThrow("fail");

        const elapsed = Date.now() - start;
        // delay schedule: 50ms (first retry), 100ms (second retry) = 150ms total
        // Allow generous tolerance for CI
        expect(elapsed).toBeGreaterThanOrEqual(120);
        expect(elapsed).toBeLessThan(500);
        expect(calls).toBe(3);
    });

    it("uses default options", async () => {
        let calls = 0;
        const start = Date.now();

        // Default: 3 attempts, 1000ms delay, 2x backoff
        // We don't want to wait 3s in tests, so just verify first-attempt success
        const result = await retry(async () => {
            calls++;
            return "fast";
        });
        expect(result).toBe("fast");
        expect(calls).toBe(1);
        expect(Date.now() - start).toBeLessThan(100);
    });
});

// ---------------------------------------------------------------------------
// vars() and clear()
// ---------------------------------------------------------------------------

describe("context management", () => {
    const BUILTIN_NAMES = new Set([
        "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
        "Promise", "URL", "TextEncoder", "TextDecoder",
        "read", "bash", "grep", "find", "edit", "write", "ls",
        "load", "save", "llm", "thread", "dispatch", "sleep",
        "diff", "retry", "vars", "clear",
    ]);

    let repl: Repl;
    let vars: () => string[];
    let clear: (varName?: string) => string;

    beforeEach(() => {
        repl = new Repl();
        // Inject some fake builtins so they appear in context
        repl.inject({
            read: () => {},
            bash: () => {},
            load: () => {},
            save: () => {},
            sleep: () => {},
            diff: () => {},
            retry: () => {},
        });

        const tools = createContextTools(repl, BUILTIN_NAMES);
        vars = tools.vars;
        clear = tools.clear;

        // Inject vars/clear themselves
        repl.inject({ vars, clear });
    });

    it("vars returns user-defined variable names", async () => {
        await repl.exec("x = 42");
        await repl.exec('name = "hello"');

        const result = vars();
        expect(result).toContain("x");
        expect(result).toContain("name");
    });

    it("vars excludes builtins", async () => {
        await repl.exec("x = 1");
        const result = vars();

        expect(result).toContain("x");
        expect(result).not.toContain("read");
        expect(result).not.toContain("bash");
        expect(result).not.toContain("console");
        expect(result).not.toContain("sleep");
        expect(result).not.toContain("diff");
        expect(result).not.toContain("retry");
        expect(result).not.toContain("vars");
        expect(result).not.toContain("clear");
        expect(result).not.toContain("Promise");
        expect(result).not.toContain("setTimeout");
    });

    it("vars returns empty array when no user variables", () => {
        expect(vars()).toEqual([]);
    });

    it("clear removes a specific variable", async () => {
        await repl.exec("x = 42");
        await repl.exec("y = 99");
        expect(vars()).toContain("x");
        expect(vars()).toContain("y");

        const msg = clear("x");
        expect(msg).toContain("Cleared");
        expect(msg).toContain("x");
        expect(vars()).not.toContain("x");
        expect(vars()).toContain("y");
    });

    it("clear without argument lists what would be cleared", async () => {
        await repl.exec("a = 1");
        await repl.exec("b = 2");

        const msg = clear();
        expect(msg).toContain("Would clear");
        expect(msg).toContain("a");
        expect(msg).toContain("b");
        // Should NOT actually clear
        expect(vars()).toContain("a");
        expect(vars()).toContain("b");
    });

    it("clear refuses to clear builtins", () => {
        const msg = clear("read");
        expect(msg).toContain("Cannot clear builtin");
        expect(msg).toContain("read");
    });

    it("clear with no user vars reports nothing to clear", () => {
        const msg = clear();
        expect(msg).toContain("No user variables");
    });

    it("vars and clear are accessible from within REPL exec", async () => {
        await repl.exec("myVar = 123");
        const r1 = await repl.exec("console.log(JSON.stringify(vars()))");
        expect(r1.output).toContain("myVar");

        await repl.exec('clear("myVar")');
        const r2 = await repl.exec("console.log(JSON.stringify(vars()))");
        expect(r2.output).not.toContain("myVar");
    });
});
