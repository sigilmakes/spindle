import type { AgentResult, SubagentOptions } from "../workers.js";

export type ThreadStatus = "queued" | "awaiting_approval" | "running" | "paused" | "done" | "failed" | "cancelled";
export type ThreadAgentStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "cached";

export interface ThreadMetaPhase {
    title: string;
    detail?: string;
    model?: string;
}

export interface ThreadMeta {
    name: string;
    description: string;
    whenToUse?: string;
    phases?: ThreadMetaPhase[];
}

export interface ThreadUsage {
    cost: number;
    subagents: number;
    toolCalls: number;
    turns: number;
}

export interface ThreadLogEntry {
    at: number;
    phase?: string;
    message: string;
    data?: unknown;
}

export interface ThreadAgentOptions extends SubagentOptions {
    label?: string;
    phase?: string;
    schema?: JsonSchema;
    retries?: number;
    cache?: "auto" | "force" | "skip";
    readonly?: boolean;
    outputCap?: number;
}

export interface ThreadAgentNode {
    id: string;
    callIndex: number;
    label: string;
    phase?: string;
    promptPreview: string;
    status: ThreadAgentStatus;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    cacheKey?: string;
    retryOf?: string;
    result?: AgentResult | unknown;
    error?: string;
    schema?: JsonSchema;
}

export interface ThreadPhaseState {
    title: string;
    detail?: string;
    status: ThreadStatus;
    agents: ThreadAgentNode[];
    usage: ThreadUsage;
    startedAt?: number;
    completedAt?: number;
}

export interface ThreadError {
    name: string;
    message: string;
    stack?: string;
    phase?: string;
    partialResult?: unknown;
}

export interface ThreadRun {
    id: string;
    name: string;
    description: string;
    status: ThreadStatus;
    scriptPath?: string;
    scriptHash: string;
    args: unknown;
    phases: ThreadPhaseState[];
    logs: ThreadLogEntry[];
    result?: unknown;
    error?: ThreadError;
    usage: ThreadUsage;
    startedAt: number;
    updatedAt: number;
    completedAt?: number;
}

export interface ThreadExecutionInput {
    script?: string;
    scriptPath?: string;
    args?: unknown;
    name?: string;
    cwd: string;
    requireApproval?: boolean;
}

export interface ThreadExecutionResult {
    run: ThreadRun;
    result: unknown;
}

export type ThreadAgentExecutor = (prompt: string, opts?: ThreadAgentOptions) => Promise<AgentResult>;

export interface ThreadRuntimeOptions {
    cwd: string;
    script?: string;
    scriptPath?: string;
    args?: unknown;
    agentExecutor: ThreadAgentExecutor;
    nestedDepth?: number;
    maxNestedDepth?: number;
    maxConcurrency?: number;
    cache?: Map<string, unknown>;
    onUpdate?: (run: ThreadRun) => void;
    resolveThreadScript?: (nameOrPath: string) => Promise<{ script: string; scriptPath?: string }>;
}

export type JsonSchema = {
    type?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: unknown[];
    additionalProperties?: boolean;
};

export interface SchemaValidationResult {
    ok: boolean;
    value?: unknown;
    errors: string[];
}
