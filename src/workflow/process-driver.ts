import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgentCompletion, WorkflowAgentDriver, WorkflowAgentRequest } from "./types.js";

// ── Process-based agent driver ───────────────────────────────────────
// Spawns `pi --mode json -p --no-session` as a child process.
// Each agent gets full isolation and all Pi coding tools.
// Supports structured output capture and abort signaling.

export interface ProcessAgentDriverOptions {
    cwd: string;
    /** Max concurrent agent processes (default: 4) */
    maxConcurrency?: number;
}

interface SubagentResult {
    exitCode: number;
    output: string;
    stderr: string;
    cost: number;
    turns: number;
    toolCalls: number;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
}

const PER_TASK_OUTPUT_CAP = 50 * 1024;

function getFinalOutput(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") return part.text;
            }
        }
    }
    return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] };
    }
    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) return { command: process.execPath, args };
    return { command: "pi", args };
}

export function createProcessAgentDriver(opts: ProcessAgentDriverOptions): WorkflowAgentDriver {
    return async (request: WorkflowAgentRequest): Promise<WorkflowAgentCompletion> => {
        const cwd = opts.cwd ?? process.cwd();
        const start = Date.now();

        const args: string[] = ["--mode", "json", "-p", "--no-session"];

        if (request.options.model) {
            args.push("--model", request.options.model);
        }

        // Build the prompt
        const prompt = buildProcessPrompt(request);
        args.push(prompt);

        let wasAborted = false;
        let result: SubagentResult = {
            exitCode: -1,
            output: "",
            stderr: "",
            cost: 0,
            turns: 0,
            toolCalls: 0,
        };

        const messages: Message[] = [];

        const exitCode = await new Promise<number>((resolve) => {
            const invocation = getPiInvocation(args);
            const proc = spawn(invocation.command, invocation.args, {
                cwd: request.options.workdir ?? cwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
            });

            let buffer = "";

            const processLine = (line: string) => {
                if (!line.trim()) return;
                let event: any;
                try { event = JSON.parse(line); } catch { return; }

                if (event.type === "message_end" && event.message) {
                    const msg = event.message as Message;
                    messages.push(msg);

                    if (msg.role === "assistant") {
                        result.turns++;
                        const usage = msg.usage;
                        if (usage) {
                            result.cost += usage.cost?.total ?? 0;
                            result.toolCalls += (usage as any).totalToolCalls ?? 0;
                        }
                        if (!result.model && msg.model) result.model = msg.model;
                        if (msg.stopReason) result.stopReason = msg.stopReason;
                        if ((msg as any).errorMessage) result.errorMessage = (msg as any).errorMessage;
                    }
                }
            };

            proc.stdout.on("data", (data) => {
                buffer += data.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) processLine(line);
            });

            proc.stderr.on("data", (data) => {
                result.stderr += data.toString();
            });

            proc.on("close", (code) => {
                if (buffer.trim()) processLine(buffer);
                resolve(code ?? 0);
            });

            proc.on("error", () => { resolve(1); });

            if (request.options.signal) {
                const killProc = () => {
                    wasAborted = true;
                    proc.kill("SIGTERM");
                    setTimeout(() => {
                        if (!proc.killed) proc.kill("SIGKILL");
                    }, 5000);
                };
                if (request.options.signal.aborted) killProc();
                else request.options.signal.addEventListener("abort", killProc, { once: true });
            }
        });

        result.exitCode = exitCode;
        if (wasAborted) throw new Error("Subagent was aborted");

        const output = getFinalOutput(messages);
        const durationMs = Date.now() - start;
        const ok = exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted";

        return {
            status: ok ? "success" : "failure",
            summary: ok ? output.slice(0, 200) : (result.errorMessage || result.stderr || "failed").slice(0, 200),
            findings: [],
            artifacts: [],
            blockers: ok ? [] : [result.errorMessage || result.stderr || "unknown error"],
            text: output,
            ok,
            value: undefined,
            raw: messages,
            cost: result.cost,
            model: result.model ?? "process-agent",
            turns: result.turns,
            toolCalls: result.toolCalls,
            durationMs,
            exitCode,
        };
    };
}

function buildProcessPrompt(request: WorkflowAgentRequest): string {
    const parts: string[] = [];
    if (request.options.systemPromptSuffix) {
        parts.push(`[Additional instructions]\n${request.options.systemPromptSuffix}`);
    }
    if (request.label) parts.push(`Task label: ${request.label}`);
    if (request.phase) parts.push(`Workflow phase: ${request.phase}`);
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