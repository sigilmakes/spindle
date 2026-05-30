import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
    createAgentSession,
    createCodingTools,
    defineTool,
    getAgentDir,
    SessionManager,
    SettingsManager,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { WorkflowAgentCompletion, WorkflowAgentRequest, WorkflowAgentDriver } from "./types.js";

export interface StructuredOutputCapture<T = unknown> {
    value: T | undefined;
    called: boolean;
}

export function createStructuredOutputTool<TSchema extends Record<string, unknown>>({
    schema,
    capture,
    name = "structured_output",
}: {
    schema: TSchema;
    capture: StructuredOutputCapture;
    name?: string;
}): ToolDefinition {
    return defineTool({
        name,
        label: "Structured Output",
        description: "Return the final machine-readable result for this subagent task.",
        promptSnippet: "Return final machine-readable output",
        promptGuidelines: [
            `${name} is the final answer channel for this task; call ${name} exactly once when done.`,
            `Do not write a prose final answer after calling ${name}.`,
        ],
        parameters: schema as any,
        async execute(_toolCallId, params) {
            capture.value = params;
            capture.called = true;
            return {
                content: [{ type: "text" as const, text: "Structured output received." }],
                details: params,
                terminate: true,
            };
        },
    });
}

function lastAssistantText(messages: AgentMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
        const text = message.content
            .filter((part): part is { type: "text"; text: string } => part.type === "text")
            .map((part) => part.text)
            .join("");
        if (text.trim()) return text;
    }
    return "";
}

function eventsToCompletion(events: AgentEvent[], text: string, durationMs: number): WorkflowAgentCompletion {
    let cost = 0;
    let turns = 0;
    let toolCalls = 0;

    for (const event of events) {
        if (event.type === "agent_end") {
            turns++;
            const agentEnd = event as any;
            cost += agentEnd.usage?.totalCost ?? 0;
            toolCalls += agentEnd.usage?.totalToolCalls ?? 0;
        }
    }

    return {
        status: "success",
        summary: text.slice(0, 200),
        findings: [],
        artifacts: [],
        blockers: [],
        text,
        ok: true,
        cost,
        model: "in-memory-agent",
        turns,
        toolCalls,
        durationMs,
        exitCode: 0,
    };
}

export interface InMemoryAgentDriverOptions {
    cwd?: string;
    agentDir?: string;
}

export function createInMemoryAgentDriver(opts: InMemoryAgentDriverOptions = {}): WorkflowAgentDriver {
    return async (request: WorkflowAgentRequest): Promise<WorkflowAgentCompletion> => {
        const cwd = opts.cwd ?? process.cwd();
        const capture: StructuredOutputCapture = { called: false, value: undefined };

        const codingTools = createCodingTools(cwd);
        const customTools: ToolDefinition[] = [];

        if (request.options.schema) {
            customTools.push(createStructuredOutputTool({
                schema: request.options.schema,
                capture,
            }));
        }

        const { session } = await createAgentSession({
            cwd,
            agentDir: opts.agentDir ?? getAgentDir(),
            sessionManager: SessionManager.inMemory(cwd),
            settingsManager: SettingsManager.inMemory({
                compaction: { enabled: false },
            }),
            customTools: [...codingTools, ...customTools],
        });

        const events: AgentEvent[] = [];
        const unsubscribe = session.subscribe((event: AgentEvent | import("@earendil-works/pi-coding-agent").AgentSessionEvent) => {
            if ((event as any).type && !(event as any).willRetry && !(event as any).steering && !(event as any).followUp) {
                events.push(event as AgentEvent);
            }
        });

        try {
            const start = Date.now();
            const prompt = buildSubagentPrompt(request);

            if (request.options.signal?.aborted) throw new Error("Subagent was aborted");

            let abortListener: (() => void) | undefined;
            if (request.options.signal) {
                const onAbort = () => void session.abort();
                request.options.signal.addEventListener("abort", onAbort, { once: true });
                abortListener = () => request.options.signal?.removeEventListener("abort", onAbort);
            }

            try {
                await session.prompt(prompt);
            } finally {
                abortListener?.();
            }

            const elapsed = Date.now() - start;

            if (request.options.schema) {
                if (!capture.called) {
                    throw new Error("Subagent finished without calling structured_output");
                }
                const completion = eventsToCompletion(events, "", elapsed);
                completion.text = JSON.stringify(capture.value);
                completion.summary = `Structured output: ${capture.value !== undefined ? "received" : "empty"}`;
                return completion;
            }

            const text = lastAssistantText(session.messages);
            return eventsToCompletion(events, text, elapsed);
        } finally {
            unsubscribe();
            session.dispose();
        }
    };
}

function buildSubagentPrompt(request: WorkflowAgentRequest): string {
    const parts: string[] = [];

    if (request.options.systemPromptSuffix) {
        parts.push(`[Additional instructions]\n${request.options.systemPromptSuffix}`);
    }
    if (request.label) {
        parts.push(`Task label: ${request.label}`);
    }
    if (request.phase) {
        parts.push(`Workflow phase: ${request.phase}`);
    }
    parts.push(request.prompt);

    if (request.options.schema) {
        parts.push([
            "Final output contract:",
            "- Your final action MUST be a structured_output tool call.",
            "- The structured_output arguments are the return value of this subagent.",
            "- Do not emit a prose final answer instead of structured_output.",
            "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"));
    }

    return parts.join("\n\n");
}

