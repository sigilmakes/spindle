import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { inspect } from "node:util";
import type { Repl } from "./repl.js";

// ---------------------------------------------------------------------------
// diff(a, b, opts?) → string
// ---------------------------------------------------------------------------

export function createDiff(cwd: string) {
    return function diff(a: string, b: string, opts?: { context?: number }): string {
        const contextLines = opts?.context ?? 3;

        let contentA = a;
        let contentB = b;
        let labelA = "a";
        let labelB = "b";

        // If inputs look like file paths (exist on disk), read them
        const resolvedA = path.resolve(cwd, a);
        const resolvedB = path.resolve(cwd, b);

        if (looksLikePath(a) && fs.existsSync(resolvedA)) {
            contentA = fs.readFileSync(resolvedA, "utf-8");
            labelA = a;
        }
        if (looksLikePath(b) && fs.existsSync(resolvedB)) {
            contentB = fs.readFileSync(resolvedB, "utf-8");
            labelB = b;
        }

        if (contentA === contentB) return "";

        // Write to temp files and shell out to diff -u
        const tmpDir = os.tmpdir();
        const tmpA = path.join(tmpDir, `spindle-diff-a-${process.pid}-${Date.now()}`);
        const tmpB = path.join(tmpDir, `spindle-diff-b-${process.pid}-${Date.now()}`);

        try {
            fs.writeFileSync(tmpA, contentA);
            fs.writeFileSync(tmpB, contentB);

            const cmd = `diff -u --label ${JSON.stringify(labelA)} --label ${JSON.stringify(labelB)} -U ${contextLines} ${JSON.stringify(tmpA)} ${JSON.stringify(tmpB)}`;
            try {
                execSync(cmd, { encoding: "utf-8" });
                return ""; // exit 0 means identical (shouldn't reach here given early check)
            } catch (err: any) {
                if (err.status === 1) {
                    // exit 1 = files differ, stdout has the diff
                    return err.stdout as string;
                }
                throw new Error(`diff command failed: ${err.message}`);
            }
        } finally {
            try { fs.unlinkSync(tmpA); } catch { /* ignore */ }
            try { fs.unlinkSync(tmpB); } catch { /* ignore */ }
        }
    };
}

/** Heuristic: a string "looks like a path" if it's short and has no newlines. */
function looksLikePath(s: string): boolean {
    return s.length < 500 && !s.includes("\n");
}

// ---------------------------------------------------------------------------
// retry(fn, opts?) → Promise<T>
// ---------------------------------------------------------------------------

export interface RetryOptions {
    attempts?: number;
    delay?: number;
    backoff?: number;
    onError?: (err: unknown, attempt: number) => void;
}

export async function retry<T>(
    fn: () => Promise<T>,
    opts?: RetryOptions,
): Promise<T> {
    const attempts = opts?.attempts ?? 3;
    const delay = opts?.delay ?? 1000;
    const backoff = opts?.backoff ?? 2;
    const onError = opts?.onError;

    let lastError: unknown;

    for (let i = 1; i <= attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            onError?.(err, i);
            if (i < attempts) {
                const waitMs = delay * Math.pow(backoff, i - 1);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
        }
    }

    throw lastError;
}

// ---------------------------------------------------------------------------
// vars() and clear() — context management
// ---------------------------------------------------------------------------

export function createContextTools(repl: Repl, builtinNames: Set<string>) {
    const context = repl.getContext();
    const effectiveBuiltins = new Set([
        ...builtinNames,
        "Buffer", "process", "require", "global", "globalThis",
    ]);

    function vars(): string[] {
        return Object.keys(context).filter(k => !effectiveBuiltins.has(k));
    }

    function clear(varName?: string): string {
        if (varName !== undefined) {
            if (effectiveBuiltins.has(varName)) {
                return `Cannot clear builtin: ${varName}`;
            }
            delete context[varName];
            return `Cleared: ${varName}`;
        }
        // No arg: list what would be cleared
        const userVars = vars();
        if (userVars.length === 0) return "No user variables to clear.";
        return `Would clear ${userVars.length} variable(s): ${userVars.join(", ")}\nPass a variable name to clear it, e.g. clear("x")`;
    }

    return { vars, clear };
}

// ---------------------------------------------------------------------------
// Inspection helpers
// ---------------------------------------------------------------------------

function resolveVar(context: Record<string, unknown>, valueOrName: unknown): unknown {
    if (typeof valueOrName === "string" && valueOrName in context) {
        return context[valueOrName];
    }
    return valueOrName;
}

function previewText(value: unknown, maxChars: number = 400): string {
    let text: string;
    if (typeof value === "string") text = value;
    else text = inspect(value, { depth: 3, breakLength: 100, maxArrayLength: 20 });
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + `... [${text.length} chars total]`;
}

function sampleValue(value: unknown, count: number = 5): unknown {
    if (Array.isArray(value)) return value.slice(0, count);
    if (typeof value === "string") return value.slice(0, count);
    if (value instanceof Map) return Array.from(value.entries()).slice(0, count);
    if (value instanceof Set) return Array.from(value.values()).slice(0, count);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, count));
    }
    return value;
}

function shapeOf(value: unknown): Record<string, unknown> {
    if (value === null) return { type: "null" };
    if (value === undefined) return { type: "undefined" };
    if (typeof value === "string") return { type: "string", length: value.length };
    if (Array.isArray(value)) return { type: "array", length: value.length, sample: value.slice(0, 3) };
    if (value instanceof Map) return { type: "map", size: value.size, sample: Array.from(value.keys()).slice(0, 5) };
    if (value instanceof Set) return { type: "set", size: value.size, sample: Array.from(value.values()).slice(0, 5) };
    if (typeof value === "function") return { type: "function", name: value.name || "anonymous" };
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        return {
            type: "object",
            keys: entries.slice(0, 10).map(([key]) => key),
            keyCount: entries.length,
        };
    }
    return { type: typeof value, value };
}

export function createInspectionTools(repl: Repl) {
    const context = repl.getContext();

    function inspectVar(name: string, opts?: { depth?: number; maxChars?: number }): string {
        if (!(name in context)) return `Unknown variable: ${name}`;
        const value = context[name];
        const rendered = inspect(value, { depth: opts?.depth ?? 3, breakLength: 100, maxArrayLength: 50 });
        return previewText(rendered, opts?.maxChars ?? 1200);
    }

    function keys(valueOrName: unknown, opts?: { limit?: number }): string[] {
        const value = resolveVar(context, valueOrName);
        const limit = Math.max(1, opts?.limit ?? 20);
        if (Array.isArray(value)) return value.slice(0, limit).map((_, i) => String(i));
        if (value instanceof Map) return Array.from(value.keys()).slice(0, limit).map((k) => String(k));
        if (value instanceof Set) return Array.from(value.values()).slice(0, limit).map((v) => String(v));
        if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).slice(0, limit);
        return [];
    }

    function shape(valueOrName: unknown): Record<string, unknown> {
        return shapeOf(resolveVar(context, valueOrName));
    }

    function sample(valueOrName: unknown, n?: number): unknown {
        return sampleValue(resolveVar(context, valueOrName), n ?? 5);
    }

    function preview(valueOrName: unknown, opts?: { maxChars?: number }): string {
        return previewText(resolveVar(context, valueOrName), opts?.maxChars ?? 400);
    }

    return { inspectVar, keys, shape, sample, preview };
}
