import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { inspect } from "node:util";
import type {
    JsonSchema,
    ThreadAgentExecutor,
    ThreadAgentNode,
    ThreadAgentOptions,
    ThreadExecutionResult,
    ThreadLogEntry,
    ThreadMeta,
    ThreadPhaseState,
    ThreadRun,
    ThreadRuntimeOptions,
    ThreadStatus,
    ThreadUsage,
} from "./types.js";
import { buildSchemaPrompt, extractJson, validateSchema } from "./schema.js";

const AsyncFunction = Object.getPrototypeOf(async function () { return undefined; }).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

function nowId(): string {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    return `th_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
}

function emptyUsage(): ThreadUsage {
    return { cost: 0, subagents: 0, toolCalls: 0, turns: 0 };
}

function addUsage(into: ThreadUsage, from: Partial<ThreadUsage>): void {
    into.cost += from.cost ?? 0;
    into.subagents += from.subagents ?? 0;
    into.toolCalls += from.toolCalls ?? 0;
    into.turns += from.turns ?? 0;
}

function sha256(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

function findObjectLiteral(source: string, start: number): string {
    const firstBrace = source.indexOf("{", start);
    if (firstBrace < 0) throw new Error("Thread meta must be an object literal");

    let depth = 0;
    let inString: string | null = null;
    let escaped = false;
    for (let i = firstBrace; i < source.length; i++) {
        const ch = source[i];
        if (inString) {
            if (escaped) { escaped = false; continue; }
            if (ch === "\\") { escaped = true; continue; }
            if (ch === inString) inString = null;
            continue;
        }
        if (ch === "\"" || ch === "'" || ch === "`") { inString = ch; continue; }
        if (ch === "{") depth++;
        if (ch === "}") {
            depth--;
            if (depth === 0) return source.slice(firstBrace, i + 1);
        }
    }
    throw new Error("Unclosed thread meta object literal");
}

export function parseThreadMeta(script: string): ThreadMeta {
    const match = script.match(/export\s+const\s+meta\s*=/);
    if (!match || match.index === undefined) {
        throw new Error("Thread scripts must start with `export const meta = { ... }`");
    }
    const literal = findObjectLiteral(script, match.index + match[0].length);
    const meta = new Function(`return (${literal});`)() as ThreadMeta;
    if (!meta || typeof meta !== "object") throw new Error("Thread meta must evaluate to an object");
    if (!meta.name || typeof meta.name !== "string") throw new Error("Thread meta.name is required");
    if (!meta.description || typeof meta.description !== "string") throw new Error("Thread meta.description is required");
    if (meta.phases && !Array.isArray(meta.phases)) throw new Error("Thread meta.phases must be an array");
    return meta;
}

function createPhases(meta: ThreadMeta): ThreadPhaseState[] {
    return (meta.phases ?? []).map((phase) => ({
        title: phase.title,
        detail: phase.detail,
        status: "queued" as ThreadStatus,
        agents: [],
        usage: emptyUsage(),
    }));
}

function transformScript(script: string): string {
    return script.replace(/export\s+const\s+meta\s*=/, "const meta =");
}

function previewPrompt(prompt: string): string {
    const oneLine = prompt.replace(/\s+/g, " ").trim();
    return oneLine.length > 140 ? `${oneLine.slice(0, 137)}...` : oneLine;
}

function formatValue(value: unknown): string {
    if (typeof value === "string") return value;
    return inspect(value, { depth: 5, breakLength: 120, maxArrayLength: 40 });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
        while (next < items.length) {
            const index = next++;
            out[index] = await fn(items[index], index);
        }
    });
    await Promise.all(workers);
    return out;
}

export class ThreadRuntime {
    private readonly opts: ThreadRuntimeOptions;
    private readonly cache: Map<string, unknown>;
    private run!: ThreadRun;
    private currentPhase: string | undefined;
    private callIndex = 0;
    private cancelled = false;

    constructor(opts: ThreadRuntimeOptions) {
        this.opts = {
            maxConcurrency: 8,
            maxNestedDepth: 1,
            nestedDepth: 0,
            ...opts,
        };
        this.cache = opts.cache ?? new Map<string, unknown>();
    }

    get currentRun(): ThreadRun {
        return this.run;
    }

    cancel(): void {
        this.cancelled = true;
        if (this.run) {
            this.run.status = "cancelled";
            this.run.updatedAt = Date.now();
            this.emit();
        }
    }

    async execute(): Promise<ThreadExecutionResult> {
        const script = await this.loadScript();
        const meta = parseThreadMeta(script);
        const start = Date.now();
        this.run = {
            id: nowId(),
            name: this.opts.scriptPath ? path.basename(this.opts.scriptPath, path.extname(this.opts.scriptPath)) : meta.name,
            description: meta.description,
            status: "running",
            scriptPath: this.opts.scriptPath,
            scriptHash: sha256(script),
            args: this.opts.args,
            phases: createPhases(meta),
            logs: [],
            usage: emptyUsage(),
            startedAt: start,
            updatedAt: start,
        };
        this.emit();

        try {
            const transformed = transformScript(script);
            const scope = this.createScope();
            const names = Object.keys(scope);
            const values = Object.values(scope);
            const fn = new AsyncFunction(...names, transformed);
            const rawResult = await fn(...values);
            const answer = scope.answer as { ready: boolean; content: unknown };
            const result = answer.ready ? answer.content : rawResult;
            if (!this.cancelled) {
                this.finishPhases("done");
                this.run.status = "done";
                this.run.result = result;
                this.run.completedAt = Date.now();
                this.run.updatedAt = this.run.completedAt;
            }
            this.emit();
            return { run: this.run, result };
        } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.run.status = this.cancelled ? "cancelled" : "failed";
            this.finishPhases(this.run.status);
            this.run.error = {
                name: error.name,
                message: error.message,
                stack: error.stack,
                phase: this.currentPhase,
            };
            this.run.completedAt = Date.now();
            this.run.updatedAt = this.run.completedAt;
            this.emit();
            if (this.cancelled) return { run: this.run, result: undefined };
            throw error;
        }
    }

    private async loadScript(): Promise<string> {
        if (this.opts.script !== undefined) return this.opts.script;
        if (!this.opts.scriptPath) throw new Error("spindle requires script, scriptPath, or name");
        return fs.readFileSync(path.resolve(this.opts.cwd, this.opts.scriptPath), "utf-8");
    }

    private emit(): void {
        this.opts.onUpdate?.(this.run);
    }

    private phaseState(title: string): ThreadPhaseState {
        let phase = this.run.phases.find((p) => p.title === title);
        if (!phase) {
            phase = { title, status: "queued", agents: [], usage: emptyUsage() };
            this.run.phases.push(phase);
        }
        return phase;
    }

    private setPhase(title: string): void {
        this.currentPhase = title;
        const phase = this.phaseState(title);
        if (phase.status === "queued") phase.status = "running";
        phase.startedAt ??= Date.now();
        this.run.updatedAt = Date.now();
        this.emit();
    }

    private log(message: string, data?: unknown): void {
        const entry: ThreadLogEntry = { at: Date.now(), phase: this.currentPhase, message, data };
        this.run.logs.push(entry);
        this.run.updatedAt = entry.at;
        this.emit();
    }

    private finishPhases(status: "done" | "failed" | "cancelled"): void {
        const completedAt = Date.now();
        for (const phase of this.run.phases) {
            if (status === "done") {
                const hasFailure = phase.agents.some((agent) => agent.status === "failed" || agent.status === "cancelled");
                phase.status = hasFailure ? "failed" : "done";
            } else if (phase.title === this.currentPhase || phase.status === "running") {
                phase.status = status;
            }
            if (phase.status !== "queued") phase.completedAt ??= completedAt;
        }
    }

    private async callAgent(prompt: string, opts: ThreadAgentOptions = {}): Promise<unknown> {
        if (this.cancelled) throw new Error("Thread cancelled");
        const phaseTitle = opts.phase ?? this.currentPhase;
        if (phaseTitle) this.setPhase(phaseTitle);
        const phase = phaseTitle ? this.phaseState(phaseTitle) : undefined;
        const callIndex = this.callIndex++;
        const label = opts.label ?? `agent:${callIndex + 1}`;
        const cacheKey = opts.cache === "skip" ? undefined : sha256(JSON.stringify({ prompt, opts: { ...opts, systemPromptSuffix: undefined } }));

        const node: ThreadAgentNode = {
            id: `a${callIndex + 1}`,
            callIndex,
            label,
            phase: phaseTitle,
            promptPreview: previewPrompt(prompt),
            status: "queued",
            cacheKey,
            schema: opts.schema,
        };
        phase?.agents.push(node);
        this.run.updatedAt = Date.now();
        this.emit();

        if (cacheKey && opts.cache !== "force" && this.cache.has(cacheKey)) {
            node.status = "cached";
            node.result = this.cache.get(cacheKey);
            node.completedAt = Date.now();
            this.emit();
            return node.result;
        }

        let attempt = 0;
        const maxAttempts = Math.max(1, (opts.retries ?? 0) + 1);
        let lastError: Error | undefined;
        while (attempt < maxAttempts) {
            attempt++;
            node.status = "running";
            node.startedAt ??= Date.now();
            this.emit();
            try {
                const systemPromptSuffix = opts.schema
                    ? [opts.systemPromptSuffix, buildSchemaPrompt(opts.schema)].filter(Boolean).join("\n\n")
                    : opts.systemPromptSuffix;
                const result = await this.opts.agentExecutor(prompt, { ...opts, systemPromptSuffix });
                const product = opts.schema ? this.extractStructured(result.text, opts.schema) : result;
                node.status = "done";
                node.result = product;
                node.completedAt = Date.now();
                node.durationMs = node.completedAt - (node.startedAt ?? node.completedAt);
                addUsage(this.run.usage, {
                    cost: result.cost,
                    subagents: 1,
                    toolCalls: result.toolCalls,
                    turns: result.turns,
                });
                if (phase) addUsage(phase.usage, {
                    cost: result.cost,
                    subagents: 1,
                    toolCalls: result.toolCalls,
                    turns: result.turns,
                });
                if (cacheKey) this.cache.set(cacheKey, product);
                this.run.updatedAt = Date.now();
                this.emit();
                return product;
            } catch (err: unknown) {
                lastError = err instanceof Error ? err : new Error(String(err));
                node.error = lastError.message;
                node.status = attempt < maxAttempts ? "queued" : "failed";
                this.log(`${label} failed${attempt < maxAttempts ? `; retrying (${attempt}/${maxAttempts})` : ""}: ${lastError.message}`);
                this.emit();
            }
        }
        throw lastError ?? new Error(`${label} failed`);
    }

    private extractStructured(text: string, schema: JsonSchema): unknown {
        const value = extractJson(text);
        const validation = validateSchema(value, schema);
        if (!validation.ok) {
            throw new Error(`Structured output failed schema validation:\n${validation.errors.join("\n")}`);
        }
        return validation.value;
    }

    private async runNestedThread(nameOrPath: string, args?: unknown): Promise<unknown> {
        const depth = this.opts.nestedDepth ?? 0;
        const maxDepth = this.opts.maxNestedDepth ?? 1;
        if (depth >= maxDepth) throw new Error("Maximum nested thread depth reached");
        if (!this.opts.resolveThreadScript) throw new Error("No thread library resolver configured");
        const resolved = await this.opts.resolveThreadScript(nameOrPath);
        const child = new ThreadRuntime({
            ...this.opts,
            script: resolved.script,
            scriptPath: resolved.scriptPath,
            args,
            nestedDepth: depth + 1,
            cache: this.cache,
            onUpdate: undefined,
        });
        const result = await child.execute();
        this.log(`nested thread ${nameOrPath} completed`, { id: result.run.id, status: result.run.status });
        return result.result;
    }

    private createScope(): Record<string, unknown> {
        const answer = {
            content: undefined as unknown,
            ready: false,
            set: (value: unknown) => { answer.content = value; return value; },
            done: (value: unknown) => { answer.content = value; answer.ready = true; return value; },
        };

        return {
            args: this.opts.args,
            context: this.opts.args,
            answer,
            phase: (title: string) => this.setPhase(title),
            log: (message: string, data?: unknown) => this.log(message, data),
            agent: (prompt: string, opts?: ThreadAgentOptions) => this.callAgent(prompt, opts),
            subagent: (prompt: string, opts?: ThreadAgentOptions) => this.callAgent(prompt, opts),
            parallel: async <T>(thunks: Array<() => Promise<T> | T>, opts?: { concurrency?: number }) => {
                const limit = opts?.concurrency ?? this.opts.maxConcurrency ?? 8;
                return await mapLimit(thunks, limit, async (thunk) => await thunk());
            },
            pipeline: async <T>(items: T[], ...stages: Array<(prev: unknown, original: T, index: number) => Promise<unknown> | unknown>) => {
                return await mapLimit(items, this.opts.maxConcurrency ?? 8, async (item, index) => {
                    let current: unknown = item;
                    for (const stage of stages) {
                        if (current === null) break;
                        try {
                            current = await stage(current, item, index);
                        } catch (err: unknown) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.log(`pipeline item ${index} dropped: ${msg}`);
                            current = null;
                        }
                    }
                    return current;
                });
            },
            thread: (nameOrPath: string, args?: unknown) => this.runNestedThread(nameOrPath, args),
            workflow: (nameOrPath: string, args?: unknown) => this.runNestedThread(nameOrPath, args),
            budget: {
                total: null,
                spent: () => this.run.usage.cost,
                remaining: () => Infinity,
                guard: (_minimum?: number) => true,
            },
            inspect: (value: unknown) => formatValue(value),
        };
    }
}

export async function runThreadRuntime(opts: ThreadRuntimeOptions): Promise<ThreadExecutionResult> {
    return await new ThreadRuntime(opts).execute();
}
