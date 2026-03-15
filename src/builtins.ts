import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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

    function vars(): string[] {
        return Object.keys(context).filter(k => !builtinNames.has(k));
    }

    function clear(varName?: string): string {
        if (varName !== undefined) {
            if (builtinNames.has(varName)) {
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
