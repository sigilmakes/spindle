import type { AgentResult, SubagentOptions } from "../workers.js";

export type WorkflowStatus = "queued" | "running" | "paused" | "waiting" | "done" | "failed" | "cancelled";
export type WorkflowAgentStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "cached";

export interface WorkflowInput {
    script?: string;
    name?: string;
    scriptPath?: string;
    args?: unknown;
    resumeFromRunId?: string;
}

export interface WorkflowMetaPhase {
    title: string;
    detail?: string;
    model?: string;
}

export interface WorkflowMeta {
    name: string;
    description: string;
    whenToUse?: string;
    phases?: WorkflowMetaPhase[];
}

export interface WorkflowUsage {
    cost: number;
    agents: number;
    toolCalls: number;
    turns: number;
}

export interface WorkflowLogEntry {
    at: number;
    phase?: string;
    message: string;
    data?: unknown;
}

export type JsonSchema = {
    type?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: unknown[];
    additionalProperties?: boolean;
};

export interface WorkflowAgentOptions extends SubagentOptions {
    label?: string;
    phase?: string;
    schema?: JsonSchema;
    retries?: number;
    cache?: "auto" | "force" | "skip";
    isolation?: "worktree";
    agentType?: string;
}

export interface WorkflowAgentRequest {
    id: string;
    runId: string;
    label: string;
    phase?: string;
    prompt: string;
    options: WorkflowAgentOptions;
}

export interface WorkflowAgentCompletion {
    status: "success" | "failure" | "blocked";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];
    text: string;
    ok: boolean;
    value?: unknown;
    raw?: AgentResult | unknown;
    cost: number;
    model: string;
    turns: number;
    toolCalls: number;
    durationMs: number;
    exitCode: number;
    branch?: string;
    worktree?: string;
}

export type WorkflowAgentDriver = (request: WorkflowAgentRequest) => Promise<WorkflowAgentCompletion>;

export interface WorkflowAgentNode {
    id: string;
    callIndex: number;
    label: string;
    phase?: string;
    promptPreview: string;
    status: WorkflowAgentStatus;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    cacheKey?: string;
    result?: WorkflowAgentCompletion | unknown;
    error?: string;
    schema?: JsonSchema;
    sessionId?: string;
}

export interface WorkflowPhaseState {
    title: string;
    detail?: string;
    status: WorkflowStatus;
    agents: string[];
    usage: WorkflowUsage;
    startedAt?: number;
    completedAt?: number;
}

export interface WorkflowFailure {
    at: number;
    scope: string;
    message: string;
}

export interface WorkflowRun {
    id: string;
    name: string;
    description: string;
    whenToUse?: string;
    status: WorkflowStatus;
    input: WorkflowInput;
    scriptPath?: string;
    scriptHash: string;
    args: unknown;
    phases: WorkflowPhaseState[];
    agents: Record<string, WorkflowAgentNode>;
    agentOrder: string[];
    logs: WorkflowLogEntry[];
    failures: WorkflowFailure[];
    result?: unknown;
    error?: { name: string; message: string; stack?: string; phase?: string };
    usage: WorkflowUsage;
    startedAt: number;
    updatedAt: number;
    completedAt?: number;
}

export interface WorkflowReceipt {
    status: "launched" | "failed_to_launch";
    runId: string;
    name: string;
    summary: string;
    scriptPath?: string;
    warning?: string;
}

export interface WorkflowExecutionResult {
    run: WorkflowRun;
    result: unknown;
}

export interface WorkflowRuntimeOptions {
    cwd: string;
    input: WorkflowInput;
    script: string;
    scriptPath?: string;
    runId?: string;
    agentDriver: WorkflowAgentDriver;
    cache?: Map<string, unknown>;
    maxConcurrency?: number;
    maxAgents?: number;
    nestedDepth?: number;
    maxNestedDepth?: number;
    onUpdate?: (run: WorkflowRun) => void;
    resolveWorkflowScript?: (nameOrPath: string) => Promise<{ script: string; scriptPath?: string }>;
}

export interface SchemaValidationResult {
    ok: boolean;
    value?: unknown;
    errors: string[];
}
