import * as vm from "node:vm";
import { types } from "node:util";

// --- Constants ---

const DEFAULT_OUTPUT_LIMIT = 8192;

/** Names injected by the host (tools, builtins). Preserved across reset, excluded from vars(). */
const TOOL_NAMES = new Set([
    "read", "bash", "grep", "find", "edit", "write", "ls",
    "load", "save", "llm", "thread", "dispatch", "sleep",
    "diff", "retry", "vars", "clear", "help",
]);

/** JS globals provided to the vm context. Excluded from vars() but NOT preserved across reset. */
const CONTEXT_GLOBALS = new Set([
    "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "Promise", "URL", "TextEncoder", "TextDecoder",
]);

/** Union of both — everything that isn't a user variable. */
const ALL_BUILTINS = new Set([...TOOL_NAMES, ...CONTEXT_GLOBALS]);

// --- Code transforms ---

/**
 * Convert top-level const/let/var declarations to bare assignments so they
 * persist on the vm context across REPL calls. "Top-level" means brace
 * depth 0 — declarations inside callbacks, loops, and blocks keep their
 * block scoping so closures work correctly.
 *
 * Only transforms declarations followed by an identifier — destructuring
 * patterns ({, [) are left as-is.
 */
function hoistDeclarations(code: string): string {
    const lines = code.split("\n");
    let depth = 0;
    const result: string[] = [];

    for (const line of lines) {
        let transformed = line;
        if (depth === 0) {
            transformed = line.replace(/^(\s*)(?:const|let|var)\s+(?=[a-zA-Z_$])/, "$1");
        }
        result.push(transformed);
        depth += netBraceChange(line);
        if (depth < 0) depth = 0;
    }

    return result.join("\n");
}

/** Count net brace change for a line, skipping braces inside strings and comments. */
function netBraceChange(line: string): number {
    let change = 0;
    let i = 0;

    while (i < line.length) {
        const ch = line[i];

        // Single-line comment — skip rest
        if (ch === "/" && line[i + 1] === "/") break;

        // Block comment (single-line only; multi-line is rare in REPL cells)
        if (ch === "/" && line[i + 1] === "*") {
            const end = line.indexOf("*/", i + 2);
            if (end === -1) break;
            i = end + 2;
            continue;
        }

        // String / template literals — skip to closing quote
        if (ch === '"' || ch === "'" || ch === "`") {
            i++;
            while (i < line.length) {
                if (line[i] === "\\") { i += 2; continue; }
                if (line[i] === ch) { i++; break; }
                i++;
            }
            continue;
        }

        if (ch === "{") change++;
        if (ch === "}") change--;
        i++;
    }

    return change;
}

/**
 * Wrap user code in an async IIFE, attempting to return the last expression
 * so the REPL can auto-print it (like Node's REPL).
 *
 * Tries to prepend `return` to the last non-empty line. If that causes a
 * syntax error (e.g. `return for(...)`) the try/catch falls back to
 * the original code with no return.
 */
function wrapWithReturn(code: string): string {
    const lines = code.split("\n");

    // Find last non-empty, non-comment line
    let lastIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed && !trimmed.startsWith("//")) {
            lastIdx = i;
            break;
        }
    }

    if (lastIdx < 0) return `(async () => {\n${code}\n})()`;

    // Try wrapping with return — if the last line isn't an expression,
    // the probe script will throw and we fall back to no return.
    const before = lines.slice(0, lastIdx).join("\n");
    const lastLine = lines[lastIdx];
    const after = lines.slice(lastIdx + 1).join("\n");
    const withReturn = [before, `return ${lastLine}`, after].filter(Boolean).join("\n");
    const candidate = `(async () => {\n${withReturn}\n})()`;

    try {
        new vm.Script(candidate, { filename: "spindle-repl-probe" });
        return candidate;
    } catch {
        return `(async () => {\n${code}\n})()`;
    }
}

// --- Public types ---

export interface ReplConfig {
    outputLimit: number;
}

export interface ExecOptions {
    signal?: AbortSignal;
    /** Strip top-level const/let/var for persistence. Default: true. */
    hoist?: boolean;
}

export interface ExecResult {
    output: string;
    truncated: boolean;
    fullSize: number;
    returnValue: unknown;
    error?: string;
    durationMs: number;
}

// --- REPL ---

export class Repl {
    private context: vm.Context;
    private config: ReplConfig;
    private _lastEpisodes: unknown[] = [];

    get lastEpisodes(): unknown[] { return this._lastEpisodes; }
    set lastEpisodes(eps: unknown[]) { this._lastEpisodes = eps; }

    constructor(config?: Partial<ReplConfig>) {
        this.config = {
            outputLimit: config?.outputLimit ?? DEFAULT_OUTPUT_LIMIT,
        };
        this.context = this.createContext();
    }

    private createContext(): vm.Context {
        return vm.createContext({
            console: undefined,
            setTimeout,
            setInterval,
            clearTimeout,
            clearInterval,
            Promise,
            URL,
            TextEncoder,
            TextDecoder,
        });
    }

    inject(bindings: Record<string, unknown>): void {
        for (const [key, value] of Object.entries(bindings)) {
            this.context[key] = value;
        }
    }

    async exec(code: string, options?: ExecOptions): Promise<ExecResult> {
        const { signal, hoist = true } = options ?? {};
        const logs: string[] = [];
        const start = Date.now();

        this.context.console = {
            log: (...args: unknown[]) => logs.push(args.map(formatValue).join(" ")),
            error: (...args: unknown[]) => logs.push("[ERROR] " + args.map(formatValue).join(" ")),
            warn: (...args: unknown[]) => logs.push("[WARN] " + args.map(formatValue).join(" ")),
            info: (...args: unknown[]) => logs.push(args.map(formatValue).join(" ")),
            dir: (obj: unknown) => logs.push(formatValue(obj)),
            table: (data: unknown) => logs.push(Array.isArray(data) ? JSON.stringify(data, null, 2) : formatValue(data)),
        };

        const prepared = hoist ? hoistDeclarations(code) : code;
        const wrapped = wrapWithReturn(prepared);

        let returnValue: unknown;
        let error: string | undefined;

        try {
            if (signal?.aborted) throw new Error("Execution aborted");

            const script = new vm.Script(wrapped, { filename: "spindle-repl" });
            const execPromise = script.runInContext(this.context);

            if (signal) {
                const abortPromise = new Promise<never>((_, reject) => {
                    if (signal.aborted) { reject(new Error("Execution aborted")); return; }
                    const onAbort = () => reject(new Error("Execution aborted"));
                    signal.addEventListener("abort", onAbort, { once: true });
                    execPromise.then(
                        () => signal.removeEventListener("abort", onAbort),
                        () => signal.removeEventListener("abort", onAbort),
                    );
                });
                returnValue = await Promise.race([execPromise, abortPromise]);
            } else {
                returnValue = await execPromise;
            }
        } catch (err: unknown) {
            error = formatError(err);
        }

        // Auto-print: if no console output and returnValue is meaningful, display it.
        if (logs.length === 0 && returnValue !== undefined && !error) {
            logs.push(formatValue(returnValue));
        }

        const fullOutput = logs.join("\n");
        const fullSize = fullOutput.length;
        const truncated = fullSize > this.config.outputLimit;
        const output = truncated
            ? fullOutput.slice(0, this.config.outputLimit) + `\n... [truncated, ${fullSize} total chars]`
            : fullOutput;

        return { output, truncated, fullSize, returnValue, error, durationMs: Date.now() - start };
    }

    getVariables(): Array<{ name: string; type: string; preview: string }> {
        const vars: Array<{ name: string; type: string; preview: string }> = [];
        for (const key of Object.keys(this.context)) {
            if (ALL_BUILTINS.has(key)) continue;
            const value = this.context[key];
            vars.push({ name: key, type: typeof value, preview: previewValue(value) });
        }
        return vars;
    }

    reset(): void {
        const old = this.context;
        this.context = this.createContext();
        for (const name of TOOL_NAMES) {
            if (typeof old[name] === "function") {
                this.context[name] = old[name];
            }
        }
    }

    getContext(): vm.Context {
        return this.context;
    }
}

// --- Formatting ---

/**
 * Cross-realm type check using V8 internals (works across vm context boundaries
 * where `instanceof` fails because constructors differ between realms).
 */
function isMap(value: unknown): value is Map<unknown, unknown> {
    return types.isMap(value);
}

function isSet(value: unknown): value is Set<unknown> {
    return types.isSet(value);
}

function formatValue(value: unknown): string {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value instanceof Error) return value.message;
    // ToolResult: show output, plus error/exitCode if notable
    if (value && typeof value === "object" && "output" in value && "ok" in value && "error" in value) {
        const r = value as { output: string; error: string; ok: boolean; exitCode: number };
        if (r.ok) return r.output || "(no output)";
        let out = r.output;
        if (r.error) out += (out && !out.endsWith("\n") ? "\n" : "") + r.error;
        if (r.exitCode !== 0) out += (out && !out.endsWith("\n") ? "\n" : "") + `[exit code ${r.exitCode}]`;
        return out || "(no output)";
    }
    if (isMap(value)) {
        const entries = Array.from(value.entries()).slice(0, 10)
            .map(([k, v]) => `${String(k)} => ${previewValue(v)}`);
        const suffix = value.size > 10 ? `, ... +${value.size - 10} more` : "";
        return `Map(${value.size}) { ${entries.join(", ")}${suffix} }`;
    }
    if (isSet(value)) {
        const entries = Array.from(value).slice(0, 10).map(v => previewValue(v));
        const suffix = value.size > 10 ? `, ... +${value.size - 10} more` : "";
        return `Set(${value.size}) { ${entries.join(", ")}${suffix} }`;
    }
    if (Array.isArray(value)) {
        if (value.length <= 5) return JSON.stringify(value);
        return `[${value.slice(0, 5).map(v => JSON.stringify(v)).join(", ")}, ... +${value.length - 5} more]`;
    }
    try {
        const str = JSON.stringify(value, null, 2);
        if (str && str.length <= 1000) return str;
        return str ? str.slice(0, 1000) + "..." : String(value);
    } catch {
        return String(value);
    }
}

function formatError(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const stack = err.stack || err.message;
    // The IIFE wrapper adds 1 line before user code — adjust line numbers.
    return stack.split("\n")
        .filter(line => !line.includes("node:vm") && !line.includes("node:internal"))
        .map(line => line.replace(/spindle-repl:(\d+)/g, (_, n) => `line ${Math.max(1, parseInt(n) - 1)}`))
        .join("\n");
}

function previewValue(value: unknown): string {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string")
        return value.length <= 50 ? `"${value}"` : `"${value.slice(0, 50)}..." (${value.length} chars)`;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (isMap(value)) return `Map(${value.size})`;
    if (isSet(value)) return `Set(${value.size})`;
    if (Array.isArray(value)) return `Array(${value.length})`;
    if (typeof value === "function") return `function ${(value as Function).name || "anonymous"}()`;
    if (typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>);
        return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""}}`;
    }
    return String(value);
}
