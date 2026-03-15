import * as vm from "node:vm";

const DEFAULT_OUTPUT_LIMIT = 8192;

export interface ReplConfig {
    outputLimit: number;
}

export interface ExecResult {
    output: string;
    truncated: boolean;
    fullSize: number;
    returnValue: unknown;
    error?: string;
    durationMs: number;
}

export class Repl {
    private context: vm.Context;
    private config: ReplConfig;

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

    async exec(code: string, signal?: AbortSignal): Promise<ExecResult> {
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

        // Sloppy-mode async IIFE: bare assignments (x = 5) persist on the context
        const wrapped = `(async () => {\n${code}\n})()`;

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

        const fullOutput = logs.join("\n");
        const fullSize = fullOutput.length;
        const truncated = fullSize > this.config.outputLimit;
        const output = truncated
            ? fullOutput.slice(0, this.config.outputLimit) + `\n... [truncated, ${fullSize} total chars]`
            : fullOutput;

        return { output, truncated, fullSize, returnValue, error, durationMs: Date.now() - start };
    }

    getVariables(): Array<{ name: string; type: string; preview: string }> {
        const builtins = new Set([
            "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
            "Promise", "URL", "TextEncoder", "TextDecoder",
            "read", "bash", "grep", "find", "edit", "write", "ls",
            "load", "save", "llm", "thread", "dispatch", "sleep",
            "diff", "retry", "vars", "clear",
        ]);

        const vars: Array<{ name: string; type: string; preview: string }> = [];
        for (const key of Object.keys(this.context)) {
            if (builtins.has(key)) continue;
            const value = this.context[key];
            vars.push({ name: key, type: typeof value, preview: previewValue(value) });
        }
        return vars;
    }

    reset(): void {
        const old = this.context;
        this.context = this.createContext();

        const preserved = [
            "read", "bash", "grep", "find", "edit", "write", "ls",
            "load", "save", "llm", "thread", "dispatch", "sleep",
            "diff", "retry", "vars", "clear",
        ];
        for (const name of preserved) {
            if (typeof old[name] === "function") {
                this.context[name] = old[name];
            }
        }
    }

    getContext(): vm.Context {
        return this.context;
    }
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
    if (value instanceof Map) {
        const entries = Array.from(value.entries()).slice(0, 10)
            .map(([k, v]) => `${String(k)} => ${previewValue(v)}`);
        const suffix = value.size > 10 ? `, ... +${value.size - 10} more` : "";
        return `Map(${value.size}) { ${entries.join(", ")}${suffix} }`;
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
    if (value instanceof Map) return `Map(${value.size})`;
    if (Array.isArray(value)) return `Array(${value.length})`;
    if (typeof value === "function") return `function ${(value as Function).name || "anonymous"}()`;
    if (typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>);
        return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""}}`;
    }
    return String(value);
}
