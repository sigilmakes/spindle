import { createRequire } from "node:module";
import { types, inspect } from "node:util";

const DEFAULT_OUTPUT_LIMIT = 8192;

const TOOL_NAMES = new Set([
    "read", "bash", "grep", "find", "edit", "write", "ls",
    "load", "save", "llm", "thread", "dispatch", "sleep",
    "diff", "retry", "vars", "clear", "help",
    "subagent", "mcp", "mcp_call", "mcp_connect", "mcp_disconnect",
]);

const CONTEXT_GLOBALS = new Set([
    "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "Promise", "URL", "TextEncoder", "TextDecoder",
    "Buffer", "process", "require", "global", "globalThis",
]);

const ALL_BUILTINS = new Set([...TOOL_NAMES, ...CONTEXT_GLOBALS]);
const requireFn = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async function () { return undefined; }).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

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

function netBraceChange(line: string): number {
    let change = 0;
    let i = 0;

    while (i < line.length) {
        const ch = line[i];

        if (ch === "/" && line[i + 1] === "/") break;

        if (ch === "/" && line[i + 1] === "*") {
            const end = line.indexOf("*/", i + 2);
            if (end === -1) break;
            i = end + 2;
            continue;
        }

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

function wrapWithReturn(code: string): string {
    const lines = code.split("\n");

    let lastIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed && !trimmed.startsWith("//")) {
            lastIdx = i;
            break;
        }
    }

    if (lastIdx < 0) return `(async () => {\n${code}\n})()`;

    const before = lines.slice(0, lastIdx).join("\n");
    const lastLine = lines[lastIdx];
    if (lastLine.includes(";")) {
        return `(async () => {\n${code}\n})()`;
    }
    const after = lines.slice(lastIdx + 1).join("\n");
    const withReturn = [before, `return ${lastLine}`, after].filter(Boolean).join("\n");
    const candidate = `(async () => {\n${withReturn}\n})()`;

    try {
        // Syntax probe without executing.
        new AsyncFunction("scope", `with (scope) { return ${candidate}; }`);
        return candidate;
    } catch {
        return `(async () => {\n${code}\n})()`;
    }
}

export interface ReplConfig {
    outputLimit: number;
}

export interface ExecOptions {
    signal?: AbortSignal;
    hoist?: boolean;
}

export type ExecStatus = "ok" | "aborted_by_user" | "runtime_error" | "process_terminated";

export interface ExecResult {
    output: string;
    truncated: boolean;
    fullSize: number;
    returnValue: unknown;
    error?: string;
    status: ExecStatus;
    durationMs: number;
}

export class Repl {
    private context: Record<string, unknown>;
    private config: ReplConfig;
    private injected = new Set<string>();
    private _lastEpisodes: unknown[] = [];

    get lastEpisodes(): unknown[] { return this._lastEpisodes; }
    set lastEpisodes(eps: unknown[]) { this._lastEpisodes = eps; }

    constructor(config?: Partial<ReplConfig>) {
        this.config = {
            outputLimit: config?.outputLimit ?? DEFAULT_OUTPUT_LIMIT,
        };
        this.context = this.createContext();
    }

    private createContext(): Record<string, unknown> {
        return {
            console: undefined,
            setTimeout,
            setInterval,
            clearTimeout,
            clearInterval,
            Promise,
            URL,
            TextEncoder,
            TextDecoder,
            Buffer,
            process,
            require: requireFn,
            global: globalThis,
            globalThis,
        };
    }

    inject(bindings: Record<string, unknown>): void {
        for (const [key, value] of Object.entries(bindings)) {
            this.context[key] = value;
            this.injected.add(key);
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

        const scope = new Proxy(this.context, {
            has: () => true,
            get: (target, prop, receiver) => {
                if (prop === Symbol.unscopables) return undefined;
                if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
                if (typeof prop === "string" && prop in globalThis) {
                    return (globalThis as Record<string, unknown>)[prop];
                }
                throw new ReferenceError(`${String(prop)} is not defined`);
            },
            set: (target, prop, value) => {
                if (typeof prop === "string") {
                    target[prop] = value;
                    return true;
                }
                return Reflect.set(target, prop, value);
            },
            deleteProperty: (target, prop) => Reflect.deleteProperty(target, prop),
            ownKeys: (target) => Reflect.ownKeys(target),
            getOwnPropertyDescriptor: (target, prop) => {
                const existing = Reflect.getOwnPropertyDescriptor(target, prop);
                if (existing) return existing;
                return {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: undefined,
                };
            },
        });

        let returnValue: unknown;
        let error: string | undefined;
        let status: ExecStatus = "ok";

        try {
            if (signal?.aborted) throw new Error("Execution aborted");

            const runner = new AsyncFunction("scope", `with (scope) { return ${wrapped}; }`);
            const execPromise = runner(scope);

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
            if (err instanceof Error && err.message === "Execution aborted") {
                error = "Aborted by user";
                status = "aborted_by_user";
            } else if (err instanceof Error && /terminated/i.test(err.message)) {
                error = formatError(err);
                status = "process_terminated";
            } else {
                error = formatError(err);
                status = "runtime_error";
            }
        }

        if (logs.length === 0 && returnValue !== undefined && !error) {
            logs.push(formatValue(returnValue));
        }

        const fullOutput = logs.join("\n");
        const fullSize = fullOutput.length;
        const truncated = fullSize > this.config.outputLimit;
        const output = truncated
            ? fullOutput.slice(0, this.config.outputLimit) + `\n... [truncated, ${fullSize} total chars]`
            : fullOutput;

        const durationMs = Date.now() - start;
        const result: ExecResult = { output, truncated, fullSize, returnValue, error, status, durationMs };
        this.context._last = returnValue;
        this.context._lastValue = returnValue;
        this.context._lastOutput = output;
        this.context._lastFullOutput = fullOutput;
        this.context._lastError = error;
        this.context._lastDurationMs = durationMs;
        this.context._lastStatus = status;
        this.context._lastTruncated = truncated;
        this.context._lastResult = result;

        return result;
    }

    getVariables(): Array<{ name: string; type: string; preview: string }> {
        const vars: Array<{ name: string; type: string; preview: string }> = [];
        for (const key of Object.keys(this.context)) {
            if (ALL_BUILTINS.has(key) || this.injected.has(key)) continue;
            const value = this.context[key];
            vars.push({ name: key, type: typeof value, preview: previewValue(value) });
        }
        return vars;
    }

    reset(): void {
        const old = this.context;
        const oldInjected = new Set(this.injected);
        this.context = this.createContext();
        this.injected = new Set();
        for (const name of Object.keys(old)) {
            if (oldInjected.has(name) || TOOL_NAMES.has(name)) {
                this.context[name] = old[name];
                this.injected.add(name);
            }
        }
    }

    getContext(): Record<string, unknown> {
        return this.context;
    }
}

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
        return str ? str.slice(0, 1000) + "..." : inspect(value, { depth: 2, breakLength: 120 });
    } catch {
        return inspect(value, { depth: 2, breakLength: 120 });
    }
}

function formatError(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const stack = err.stack || err.message;
    return stack.split("\n")
        .filter(line => !line.includes("node:internal"))
        .map(line => line.replace(/anonymous:(\d+):(\d+)/g, (_m, line, col) => `line ${Math.max(1, parseInt(line, 10) - 1)}:${col}`))
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
