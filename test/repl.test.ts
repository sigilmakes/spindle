import { describe, it, expect, beforeEach } from "vitest";
import { Repl } from "../src/repl.js";

describe("Repl", () => {
    let repl: Repl;

    beforeEach(() => {
        repl = new Repl();
    });

    describe("basic execution", () => {
        it("executes simple expressions", async () => {
            const result = await repl.exec('console.log("hello")');
            expect(result.output).toBe("hello");
            expect(result.error).toBeUndefined();
        });

        it("evaluates arithmetic", async () => {
            const result = await repl.exec("console.log(2 + 2)");
            expect(result.output).toBe("4");
        });

        it("handles multi-line code", async () => {
            const result = await repl.exec('console.log("a")\nconsole.log("b")');
            expect(result.output).toBe("a\nb");
        });

        it("supports top-level await", async () => {
            const result = await repl.exec("const v = await Promise.resolve(42)\nconsole.log(v)");
            expect(result.output).toBe("42");
        });
    });

    describe("variable persistence", () => {
        it("persists bare assignments across calls", async () => {
            await repl.exec("x = 42");
            const result = await repl.exec("console.log(x)");
            expect(result.output).toBe("42");
        });

        it("persists objects", async () => {
            await repl.exec('data = { name: "test", count: 5 }');
            const result = await repl.exec("console.log(data.name, data.count)");
            expect(result.output).toBe("test 5");
        });

        it("persists arrays", async () => {
            await repl.exec("items = [1, 2, 3]");
            const result = await repl.exec("console.log(items.length)");
            expect(result.output).toBe("3");
        });

        it("does NOT persist const/let (block-scoped in IIFE)", async () => {
            await repl.exec("const localVar = 99");
            const result = await repl.exec('try { console.log(localVar) } catch { console.log("gone") }');
            expect(result.output).toBe("gone");
        });
    });

    describe("console capture", () => {
        it("captures console.log", async () => {
            expect((await repl.exec('console.log("test")')).output).toBe("test");
        });

        it("captures console.error with prefix", async () => {
            expect((await repl.exec('console.error("bad")')).output).toBe("[ERROR] bad");
        });

        it("captures console.warn with prefix", async () => {
            expect((await repl.exec('console.warn("hmm")')).output).toBe("[WARN] hmm");
        });

        it("formats multiple arguments", async () => {
            expect((await repl.exec('console.log("a", 1, true)')).output).toBe("a 1 true");
        });

        it("formats objects as JSON", async () => {
            const result = await repl.exec("console.log({ a: 1 })");
            expect(result.output).toContain('"a": 1');
        });

        it("formats null and undefined", async () => {
            expect((await repl.exec("console.log(null, undefined)")).output).toBe("null undefined");
        });
    });

    describe("error handling", () => {
        it("reports syntax errors", async () => {
            expect((await repl.exec("const x = {")).error).toBeDefined();
        });

        it("reports thrown errors", async () => {
            expect((await repl.exec("throw new Error('boom')")).error).toContain("boom");
        });

        it("reports reference errors", async () => {
            expect((await repl.exec("console.log(undefinedVar)")).error).toContain("undefinedVar");
        });

        it("survives errors without corrupting state", async () => {
            await repl.exec("throw new Error('crash')");
            const result = await repl.exec('console.log("ok")');
            expect(result.output).toBe("ok");
            expect(result.error).toBeUndefined();
        });
    });

    describe("output truncation", () => {
        it("truncates output exceeding the limit", async () => {
            const r = new Repl({ outputLimit: 100 });
            const result = await r.exec('for (i = 0; i < 1000; i++) console.log("line " + i)');
            expect(result.truncated).toBe(true);
            expect(result.output).toContain("truncated");
            expect(result.fullSize).toBeGreaterThan(100);
        });

        it("does not truncate short output", async () => {
            expect((await repl.exec('console.log("short")')).truncated).toBe(false);
        });
    });

    describe("inject", () => {
        it("injects sync functions", async () => {
            repl.inject({ double: (x: number) => x * 2 });
            expect((await repl.exec("console.log(double(21))")).output).toBe("42");
        });

        it("injects async functions", async () => {
            repl.inject({ fetchVal: async () => "got it" });
            const result = await repl.exec('r = await fetchVal()\nconsole.log(r)');
            expect(result.output).toBe("got it");
        });

        it("injects plain objects", async () => {
            repl.inject({ cfg: { port: 3000 } });
            expect((await repl.exec("console.log(cfg.port)")).output).toBe("3000");
        });
    });

    describe("getVariables", () => {
        it("lists user-defined variables", async () => {
            await repl.exec("x = 42");
            await repl.exec('name = "test"');
            const names = repl.getVariables().map(v => v.name);
            expect(names).toContain("x");
            expect(names).toContain("name");
        });

        it("excludes built-in and injected bindings", async () => {
            repl.inject({ read: () => {}, bash: () => {} });
            await repl.exec("x = 1");
            const names = repl.getVariables().map(v => v.name);
            expect(names).toContain("x");
            expect(names).not.toContain("read");
            expect(names).not.toContain("console");
        });

        it("includes type and preview", async () => {
            await repl.exec("count = 42");
            const v = repl.getVariables().find(v => v.name === "count")!;
            expect(v.type).toBe("number");
            expect(v.preview).toBe("42");
        });
    });

    describe("reset", () => {
        it("clears user variables", async () => {
            await repl.exec("x = 42");
            repl.reset();
            const result = await repl.exec('try { console.log(x) } catch { console.log("cleared") }');
            expect(result.output).toBe("cleared");
        });

        it("preserves injected tool functions", async () => {
            repl.inject({ sleep: async () => "works" });
            repl.reset();
            expect((await repl.exec('r = await sleep()\nconsole.log(r)')).output).toBe("works");
        });
    });

    describe("abort", () => {
        it("aborts on signal", async () => {
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 50);
            const result = await repl.exec("await new Promise(r => setTimeout(r, 10000))", ac.signal);
            expect(result.error).toContain("abort");
        });

        it("handles already-aborted signal", async () => {
            const ac = new AbortController();
            ac.abort();
            expect((await repl.exec('console.log("hi")', ac.signal)).error).toContain("abort");
        });
    });

    describe("timeout", () => {
        it("times out long-running code", async () => {
            const r = new Repl({ timeoutMs: 100 });
            const result = await r.exec("await new Promise(r => setTimeout(r, 10000))");
            expect(result.error).toContain("timed out");
        });
    });

    describe("duration tracking", () => {
        it("tracks wall-clock duration", async () => {
            const result = await repl.exec("await new Promise(r => setTimeout(r, 50))");
            expect(result.durationMs).toBeGreaterThanOrEqual(40);
        });
    });
});
