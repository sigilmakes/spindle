import * as crypto from "node:crypto";
import type {
    JsonSchema,
    WorkflowAgentCompletion,
    WorkflowAgentNode,
    WorkflowAgentOptions,
    WorkflowAgentRequest,
    WorkflowExecutionResult,
    WorkflowLogEntry,
    WorkflowMeta,
    WorkflowPhaseState,
    WorkflowRun,
    WorkflowRuntimeOptions,
    WorkflowStatus,
    WorkflowUsage,
} from "./types.js";
import { buildSchemaPrompt, extractJson, validateSchema } from "./schema.js";
import { parseWorkflowMeta, transformWorkflowScript } from "./meta.js";

const AsyncFunction = Object.getPrototypeOf(async function () { return undefined; }).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

function nowId(): string {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    return `wf_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
}

function emptyUsage(): WorkflowUsage {
    return { cost: 0, agents: 0, toolCalls: 0, turns: 0 };
}

function addUsage(into: WorkflowUsage, from: Partial<WorkflowUsage>): void {
    into.cost += from.cost ?? 0;
    into.agents += from.agents ?? 0;
    into.toolCalls += from.toolCalls ?? 0;
    into.turns += from.turns ?? 0;
}

function sha256(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

function createPhases(meta: WorkflowMeta): WorkflowPhaseState[] {
    return (meta.phases ?? []).map((phase) => ({
        title: phase.title,
        detail: phase.detail,
        status: "queued" as WorkflowStatus,
        agents: [],
        usage: emptyUsage(),
    }));
}

function previewPrompt(prompt: string): string {
    const oneLine = prompt.replace(/\s+/g, " ").trim();
    return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
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

export class WorkflowRuntime {
    private readonly opts: WorkflowRuntimeOptions;
    private readonly cache: Map<string, unknown>;
    private run!: WorkflowRun;
    private currentPhase: string | undefined;
    private callIndex = 0;
    private cancelled = false;

    constructor(opts: WorkflowRuntimeOptions) {
        this.opts = {
            maxConcurrency: 16,
            maxAgents: 1000,
            maxNestedDepth: 1,
            nestedDepth: 0,
            ...opts,
        };
        this.cache = opts.cache ?? new Map<string, unknown>();
    }

    get currentRun(): WorkflowRun { return this.run; }

    cancel(): void {
        this.cancelled = true;
        if (this.run) {
            this.run.status = "cancelled";
            this.run.updatedAt = Date.now();
            this.emit();
        }
    }

    async execute(): Promise<WorkflowExecutionResult> {
        const meta = parseWorkflowMeta(this.opts.script);
        const start = Date.now();
        this.run = {
            id: this.opts.runId ?? nowId(),
            name: meta.name,
            description: meta.description,
            whenToUse: meta.whenToUse,
            status: "running",
            input: this.opts.input,
            scriptPath: this.opts.scriptPath,
            scriptHash: sha256(this.opts.script),
            args: this.opts.input.args,
            phases: createPhases(meta),
            agents: {},
            agentOrder: [],
            logs: [],
            failures: [],
            usage: emptyUsage(),
            startedAt: start,
            updatedAt: start,
        };
        this.emit();

        try {
            const transformed = transformWorkflowScript(this.opts.script);
            const scope = this.createScope();
            const fn = new AsyncFunction(...Object.keys(scope), transformed);
            const result = await fn(...Object.values(scope));
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
            this.run.error = { name: error.name, message: error.message, stack: error.stack, phase: this.currentPhase };
            this.run.completedAt = Date.now();
            this.run.updatedAt = this.run.completedAt;
            this.emit();
            if (this.cancelled) return { run: this.run, result: undefined };
            throw error;
        }
    }

    private emit(): void { this.opts.onUpdate?.(this.run); }

    private phaseState(title: string): WorkflowPhaseState {
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

    private wfLog(message: string, data?: unknown): void {
        const entry: WorkflowLogEntry = { at: Date.now(), phase: this.currentPhase, message, data };
        this.run.logs.push(entry);
        this.run.updatedAt = entry.at;
        this.emit();
    }

    private recordFailure(scope: string, message: string): void {
        this.run.failures.push({ at: Date.now(), scope, message });
        this.wfLog(`${scope} failed: ${message}`);
    }

    private finishPhases(status: "done" | "failed" | "cancelled"): void {
        const completedAt = Date.now();
        for (const phase of this.run.phases) {
            if (status === "done") {
                const hasFailure = phase.agents.some((id: string) => {
                    const agent = this.run.agents[id];
                    return agent?.status === "failed" || agent?.status === "cancelled";
                });
                phase.status = hasFailure ? "failed" : "done";
            } else if (phase.title === this.currentPhase || phase.status === "running") {
                phase.status = status;
            }
            if (phase.status !== "queued") phase.completedAt ??= completedAt;
        }
    }

    private async callAgent(prompt: string, opts: WorkflowAgentOptions = {}): Promise<unknown> {
        if (this.cancelled) throw new Error("Workflow cancelled");
        if (this.callIndex >= (this.opts.maxAgents ?? 1000)) throw new Error(`Workflow agent cap exceeded (${this.opts.maxAgents ?? 1000})`);

        const phaseTitle = opts.phase ?? this.currentPhase;
        if (phaseTitle) this.setPhase(phaseTitle);
        const phase = phaseTitle ? this.phaseState(phaseTitle) : undefined;
        const callIndex = this.callIndex++;
        const label = opts.label ?? `agent:${callIndex + 1}`;
        const id = `a${callIndex + 1}`;
        const cacheKey = opts.cache === "skip" ? undefined : sha256(JSON.stringify({ prompt, opts: { ...opts, label: undefined, systemPromptSuffix: undefined } }));

        const node: WorkflowAgentNode = {
            id,
            callIndex,
            label,
            phase: phaseTitle,
            promptPreview: previewPrompt(prompt),
            status: "queued",
            cacheKey,
            schema: opts.schema,
        };
        this.run.agents[id] = node;
        this.run.agentOrder.push(id);
        phase?.agents.push(id);
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
                const request: WorkflowAgentRequest = {
                    id,
                    runId: this.run.id,
                    label,
                    phase: phaseTitle,
                    prompt,
                    options: {
                        ...opts,
                        systemPromptSuffix,
                        worktree: opts.worktree ?? opts.isolation === "worktree",
                        agent: opts.agent ?? opts.agentType,
                    },
                };
                const completion = await this.opts.agentDriver(request);
                const product = opts.schema ? this.extractStructured(completion.text, opts.schema) : completion.text;
                node.status = "completed";
                node.result = opts.schema ? product : completion;
                node.completedAt = Date.now();
                node.durationMs = node.completedAt - (node.startedAt ?? node.completedAt);
                addUsage(this.run.usage, { cost: completion.cost, agents: 1, toolCalls: completion.toolCalls, turns: completion.turns });
                if (phase) addUsage(phase.usage, { cost: completion.cost, agents: 1, toolCalls: completion.toolCalls, turns: completion.turns });
                if (cacheKey) this.cache.set(cacheKey, product);
                this.run.updatedAt = Date.now();
                this.emit();
                return product;
            } catch (err: unknown) {
                lastError = err instanceof Error ? err : new Error(String(err));
                node.error = lastError.message;
                node.status = attempt < maxAttempts ? "queued" : "failed";
                this.recordFailure(label, lastError.message);
                this.emit();
            }
        }
        throw lastError ?? new Error(`${label} failed`);
    }

    private extractStructured(text: string, schema: JsonSchema): unknown {
        const value = extractJson(text);
        const validation = validateSchema(value, schema);
        if (!validation.ok) throw new Error(`Structured output failed schema validation:\n${validation.errors.join("\n")}`);
        return validation.value;
    }

    private async runNestedWorkflow(nameOrPath: string, args?: unknown): Promise<unknown> {
        const depth = this.opts.nestedDepth ?? 0;
        const maxDepth = this.opts.maxNestedDepth ?? 1;
        if (depth >= maxDepth) throw new Error("Maximum nested workflow depth reached");
        if (!this.opts.resolveWorkflowScript) throw new Error("No workflow resolver configured");
        const resolved = await this.opts.resolveWorkflowScript(nameOrPath);
        const child = new WorkflowRuntime({
            ...this.opts,
            input: { name: nameOrPath, args },
            script: resolved.script,
            scriptPath: resolved.scriptPath,
            cache: this.cache,
            nestedDepth: depth + 1,
            onUpdate: undefined,
        });
        const result = await child.execute();
        this.wfLog(`workflow ${nameOrPath} completed`, { id: result.run.id, status: result.run.status });
        return result.result;
    }

    private createScope(): Record<string, unknown> {
        return {
            args: this.opts.input.args,
            phase: (title: string) => this.setPhase(title),
            log: (message: string, data?: unknown) => this.wfLog(message, data),
            agent: (prompt: string, opts?: WorkflowAgentOptions) => this.callAgent(prompt, opts),
            parallel: async <T>(thunks: Array<() => Promise<T> | T>, opts?: { concurrency?: number }) => {
                const limit = opts?.concurrency ?? this.opts.maxConcurrency ?? 16;
                return await mapLimit(thunks, limit, async (thunk: () => Promise<T> | T, index: number) => {
                    let produced: Promise<T> | T;
                    try { produced = thunk(); } catch (err: unknown) { throw err; }
                    try { return await produced; } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.recordFailure(`parallel[${index}]`, msg);
                        return null as T;
                    }
                });
            },
            pipeline: async <T>(items: T[], ...stages: Array<(prev: unknown, original: T, index: number) => Promise<unknown> | unknown>) => {
                return await mapLimit(items, this.opts.maxConcurrency ?? 16, async (item: T, index: number) => {
                    let current: unknown = item;
                    for (const stage of stages) {
                        if (current === null) break;
                        try { current = await stage(current, item, index); } catch (err: unknown) {
                            const msg = err instanceof Error ? err.message : String(err);
                            this.recordFailure(`pipeline[${index}]`, msg);
                            current = null;
                        }
                    }
                    return current;
                });
            },
            workflow: (nameOrPath: string, args?: unknown) => this.runNestedWorkflow(nameOrPath, args),
            budget: { total: null, spent: () => this.run.usage.cost, remaining: () => Infinity },
        };
    }
}

export async function runWorkflowRuntime(opts: WorkflowRuntimeOptions): Promise<WorkflowExecutionResult> {
    return await new WorkflowRuntime(opts).execute();
}

export function summarizeWorkflowRun(run: WorkflowRun): string {
    const done = run.agentOrder.filter((id) => {
        const status = run.agents[id]?.status;
        return status === "completed" || status === "cached";
    }).length;
    const total = run.agentOrder.length;
    const cost = run.usage.cost ? `$${run.usage.cost.toFixed(4)}` : "$0.0000";
    const elapsed = ((run.completedAt ?? Date.now()) - run.startedAt) / 1000;
    return `${run.status} · ${done}/${total} agents · ${cost} · ${elapsed.toFixed(1)}s`;
}