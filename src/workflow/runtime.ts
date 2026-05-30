import * as vm from "node:vm";
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
import { parseWorkflowScript } from "./meta.js";

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

function createLimiter(limit: number) {
    let active = 0;
    const queue: Array<() => void> = [];
    const next = () => {
        active--;
        queue.shift()?.();
    };
    return async <T>(fn: () => Promise<T>): Promise<T> => {
        if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
        active++;
        try {
            return await fn();
        } finally {
            next();
        }
    };
}

const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

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
        const { meta, body } = parseWorkflowScript(this.opts.script);
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
            if (this.opts.signal?.aborted) throw new Error("Workflow aborted");

            const limiter = createLimiter(this.opts.maxConcurrency ?? 16);
            const state = { logs: [] as string[], phases: [] as string[], agentCount: 0, spent: 0 };

            const wfLog = (message: string, data?: unknown) => {
                const text = String(message);
                state.logs.push(text);
                const entry: WorkflowLogEntry = { at: Date.now(), phase: this.currentPhase, message: text, data };
                this.run.logs.push(entry);
                this.run.updatedAt = entry.at;
                this.emit();
            };

            const phase = (title: string) => {
                this.currentPhase = title;
                let phaseState = this.run.phases.find((p) => p.title === title);
                if (!phaseState) {
                    phaseState = { title, status: "running", agents: [], usage: emptyUsage(), startedAt: Date.now() };
                    this.run.phases.push(phaseState);
                } else if (phaseState.status === "queued") {
                    phaseState.status = "running";
                    phaseState.startedAt ??= Date.now();
                }
                if (!state.phases.includes(title)) state.phases.push(title);
                this.run.updatedAt = Date.now();
                this.emit();
            };

            const budget = Object.freeze({
                total: null as number | null,
                spent: () => this.run.usage.cost,
                remaining: () => Infinity,
            });

            const throwIfAborted = () => {
                if (this.opts.signal?.aborted || this.cancelled) throw new Error("Workflow aborted");
            };

            const agent = async (prompt: string, agentOptions: WorkflowAgentOptions = {}): Promise<unknown> => {
                throwIfAborted();
                const phaseTitle = agentOptions.phase ?? this.currentPhase;
                if (phaseTitle) this.setPhase(phaseTitle);
                const callIndex = this.callIndex++;
                const label = agentOptions.label?.trim() || `agent:${callIndex + 1}`;
                const id = `a${callIndex + 1}`;
                const cacheKey = agentOptions.cache === "skip" ? undefined : sha256(JSON.stringify({ prompt, opts: { ...agentOptions, label: undefined, systemPromptSuffix: undefined } }));

                const phaseState = phaseTitle ? this.run.phases.find((p) => p.title === phaseTitle) : undefined;
                const node: WorkflowAgentNode = {
                    id,
                    callIndex,
                    label,
                    phase: phaseTitle,
                    promptPreview: previewPrompt(prompt),
                    status: "queued",
                    cacheKey,
                    schema: agentOptions.schema,
                };
                this.run.agents[id] = node;
                this.run.agentOrder.push(id);
                phaseState?.agents.push(id);
                this.run.updatedAt = Date.now();
                this.emit();

                return limiter(async () => {
                    // Check cache
                    if (cacheKey && agentOptions.cache !== "force" && this.cache.has(cacheKey)) {
                        node.status = "cached";
                        node.result = this.cache.get(cacheKey);
                        node.completedAt = Date.now();
                        this.emit();
                        return node.result;
                    }

                    let attempt = 0;
                    const maxAttempts = Math.max(1, (agentOptions.retries ?? 0) + 1);
                    let lastError: Error | undefined;

                    while (attempt < maxAttempts) {
                        attempt++;
                        throwIfAborted();
                        node.status = "running";
                        node.startedAt ??= Date.now();
                        this.emit();
                        this.opts.onAgentStart?.({ id, label, phase: phaseTitle, prompt });
                        try {
                            const systemPromptSuffix = agentOptions.schema
                                ? [agentOptions.systemPromptSuffix, buildSchemaPrompt(agentOptions.schema)].filter(Boolean).join("\n\n")
                                : agentOptions.systemPromptSuffix;
                            const request: WorkflowAgentRequest = {
                                id,
                                runId: this.run.id,
                                label,
                                phase: phaseTitle,
                                prompt,
                                options: {
                                    ...agentOptions,
                                    systemPromptSuffix,
                                    worktree: agentOptions.worktree ?? agentOptions.isolation === "worktree",
                                    agent: agentOptions.agent ?? agentOptions.agentType,
                                    signal: this.opts.signal,
                                },
                            };
                            const completion = await this.opts.agentDriver(request);
                            throwIfAborted();

                            const product = agentOptions.schema ? this.extractStructured(completion.text, agentOptions.schema) : completion.text;
                            node.status = "completed";
                            node.result = agentOptions.schema ? product : completion;
                            node.completedAt = Date.now();
                            node.durationMs = node.completedAt - (node.startedAt ?? node.completedAt);
                            addUsage(this.run.usage, { cost: completion.cost, agents: 1, toolCalls: completion.toolCalls, turns: completion.turns });
                            if (phaseState) addUsage(phaseState.usage, { cost: completion.cost, agents: 1, toolCalls: completion.toolCalls, turns: completion.turns });
                            if (cacheKey) this.cache.set(cacheKey, product);
                            this.run.updatedAt = Date.now();
                            this.emit();
                            this.opts.onAgentEnd?.({ id, label, phase: phaseTitle, result: product });
                            return product;
                        } catch (err: unknown) {
                            lastError = err instanceof Error ? err : new Error(String(err));
                            node.error = lastError.message;
                            node.status = attempt < maxAttempts ? "queued" : "failed";
                            this.recordFailure(label, lastError.message);
                            this.emit();
                            if (attempt >= maxAttempts) this.opts.onAgentEnd?.({ id, label, phase: phaseTitle, result: null });
                            if (this.opts.signal?.aborted) throw err;
                        }
                    }

                    // For parallel/pipeline: return null instead of throwing
                    wfLog(`agent ${label} failed: ${lastError?.message ?? "unknown"}`);
                    return null;
                });
            };

            const parallel = async (thunks: Array<() => Promise<unknown> | unknown>) => {
                throwIfAborted();
                if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
                if (thunks.some((thunk) => typeof thunk !== "function")) {
                    throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
                }
                return Promise.all(
                    thunks.map(async (thunk, index) => {
                        try {
                            return await thunk();
                        } catch (err: unknown) {
                            if (this.opts.signal?.aborted) throw err;
                            const msg = err instanceof Error ? err.message : String(err);
                            this.recordFailure(`parallel[${index}]`, msg);
                            return null;
                        }
                    }),
                );
            };

            const pipeline = async (
                items: unknown[],
                ...stages: Array<(prev: unknown, original: unknown, index: number) => Promise<unknown> | unknown>
            ) => {
                throwIfAborted();
                if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
                if (stages.some((stage) => typeof stage !== "function")) {
                    throw new TypeError("pipeline() stages must be functions");
                }
                return Promise.all(
                    items.map(async (item, index) => {
                        let value: unknown = item;
                        for (const stage of stages) {
                            try {
                                throwIfAborted();
                                value = await stage(value, item, index);
                                throwIfAborted();
                            } catch (err: unknown) {
                                if (this.opts.signal?.aborted) throw err;
                                const msg = err instanceof Error ? err.message : String(err);
                                this.recordFailure(`pipeline[${index}]`, msg);
                                return null;
                            }
                        }
                        return value;
                    }),
                );
            };

            const workflow = async (nameOrPath: string, args?: unknown): Promise<unknown> => {
                throwIfAborted();
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
                wfLog(`workflow ${nameOrPath} completed`, { id: result.run.id, status: result.run.status });
                return result.result;
            };

            const context = vm.createContext({
                agent,
                parallel,
                pipeline,
                workflow,
                log: wfLog,
                phase,
                args: this.opts.input.args,
                cwd: this.opts.cwd ?? process.cwd(),
                process: Object.freeze({ cwd: () => this.opts.cwd ?? process.cwd() }),
                budget,
                console: {
                    log: wfLog,
                    info: wfLog,
                    warn: (m: unknown) => wfLog(`[warn] ${String(m)}`),
                    error: (m: unknown) => wfLog(`[error] ${String(m)}`),
                },
                JSON,
                Math,
                Array,
                Object,
                String,
                Number,
                Boolean,
                Set,
                Map,
                Promise,
                RegExp,
                Error,
                TypeError,
                RangeError,
                parseInt,
                parseFloat,
                isNaN,
                isFinite,
                encodeURIComponent,
                decodeURIComponent,
            });

            const wrapped = `(async () => {\n${body}\n})()`;
            const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context, { timeout: 600_000 });

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

    private setPhase(title: string): void {
        this.currentPhase = title;
        let phase = this.run.phases.find((p) => p.title === title);
        if (!phase) {
            phase = { title, status: "running", agents: [], usage: emptyUsage() };
            this.run.phases.push(phase);
        } else if (phase.status === "queued") {
            phase.status = "running";
        }
        phase.startedAt ??= Date.now();
        this.run.updatedAt = Date.now();
        this.emit();
    }

    private recordFailure(scope: string, message: string): void {
        this.run.failures.push({ at: Date.now(), scope, message });
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

    private extractStructured(text: string, schema: JsonSchema): unknown {
        const value = extractJson(text);
        const validation = validateSchema(value, schema);
        if (!validation.ok) throw new Error(`Structured output failed schema validation:\n${validation.errors.join("\n")}`);
        return validation.value;
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