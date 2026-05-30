import type { WorkflowAgentCompletion, WorkflowAgentNode, WorkflowRun, WorkflowStatus } from "./types.js";

export interface AgentSessionHandle {
    id: string;
    label: string;
    status: "starting" | "running" | "idle" | "completed" | "failed";
    startedAt: number;
    completedAt?: number;
    result?: WorkflowAgentCompletion;
    /** Send a message to the agent mid-run */
    message(text: string): Promise<void>;
    /** Wait for the agent to complete and return its result */
    wait(timeoutMs?: number): Promise<WorkflowAgentCompletion>;
    /** Force-complete the agent */
    complete(result: WorkflowAgentCompletion): void;
}

type ResolveFn = (value: WorkflowAgentCompletion) => void;

const handles = new Map<string, { handle: AgentSessionHandleImpl; resolve: ResolveFn }>();

export class AgentSessionHandleImpl implements AgentSessionHandle {
    id: string;
    label: string;
    status: "starting" | "running" | "idle" | "completed" | "failed" = "running";
    startedAt: number;
    completedAt?: number;
    result?: WorkflowAgentCompletion;
    private _resolve: ResolveFn | null = null;
    private _messages: string[] = [];

    constructor(id: string, label: string) {
        this.id = id;
        this.label = label;
        this.startedAt = Date.now();
    }

    setResolve(resolve: ResolveFn): void {
        this._resolve = resolve;
    }

    get pendingMessages(): string[] {
        const msgs = [...this._messages];
        this._messages = [];
        return msgs;
    }

    async message(text: string): Promise<void> {
        if (this.status !== "running" && this.status !== "idle") {
            throw new Error(`Agent ${this.id} is ${this.status}, cannot message`);
        }
        this._messages.push(text);
    }

    async wait(timeoutMs: number = 600_000): Promise<WorkflowAgentCompletion> {
        if (this.result) return this.result;
        return new Promise<WorkflowAgentCompletion>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Agent ${this.id} timed out after ${timeoutMs}ms`)), timeoutMs);
            const originalResolve = this._resolve;
            this._resolve = (value: WorkflowAgentCompletion) => {
                clearTimeout(timer);
                originalResolve?.(value);
                resolve(value);
            };
        });
    }

    complete(result: WorkflowAgentCompletion): void {
        this.result = result;
        this.status = result.ok ? "completed" : "failed";
        this.completedAt = Date.now();
        this._resolve?.(result);
        this._resolve = null;
    }
}

export function createSessionHandle(id: string, label: string): AgentSessionHandleImpl {
    const handle = new AgentSessionHandleImpl(id, label);
    // Store the promise resolver
    let resolveFn: ResolveFn;
    const promise = new Promise<WorkflowAgentCompletion>((res) => { resolveFn = res; });
    handle.setResolve(resolveFn!);
    handles.set(id, { handle, resolve: resolveFn! });
    return handle;
}

export function getSessionHandle(id: string): AgentSessionHandle | undefined {
    return handles.get(id)?.handle;
}

export function completeSession(id: string, result: WorkflowAgentCompletion): boolean {
    const entry = handles.get(id);
    if (!entry) return false;
    entry.handle.complete(result);
    return true;
}

export function listSessionHandles(): AgentSessionHandle[] {
    return [...handles.values()].map((e) => e.handle).sort((a, b) => a.startedAt - b.startedAt);
}

export function clearSessionHandles(): void {
    handles.clear();
}

export function agentNodeFromHandle(handle: AgentSessionHandle, phase?: string): Partial<WorkflowAgentNode> {
    return {
        id: handle.id,
        label: handle.label,
        status: agentStatusFromSession(handle.status),
        startedAt: handle.startedAt,
        completedAt: handle.completedAt,
        sessionId: handle.id,
    };
}

function agentStatusFromSession(status: string): WorkflowAgentNode["status"] {
    switch (status) {
        case "completed": return "completed";
        case "failed": return "failed";
        case "running": case "starting": return "running";
        case "idle": return "waiting";
        default: return "queued";
    }
}