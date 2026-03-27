/**
 * Worker Extension — loaded by pi subagent processes spawned by spindle.
 *
 * 1. Injects episode prompt via before_agent_start so the agent writes
 *    a structured <episode> block at the end of its response.
 * 2. Hooks pi lifecycle events and writes structured status to
 *    .spindle/status.json in the working directory.
 * 3. Parses the <episode> block from agent_end and includes it in the
 *    status file so the orchestrator gets structured results.
 * 4. Calls ctx.shutdown() when the agent finishes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATUS_DIR = ".spindle";
const STATUS_FILE = "status.json";

const EPISODE_PROMPT = `
After completing your task, end your response with a structured episode block.
This block MUST be the last thing in your response.

<episode>
status: success | failure | blocked
summary: One paragraph describing what you accomplished and key conclusions.
findings:
- Finding or deliverable 1
- Finding or deliverable 2
artifacts:
- path/to/file — what was created or modified
blockers:
- (only if status is blocked) What's preventing progress
</episode>
`.trim();

interface Episode {
    status: "success" | "failure" | "blocked";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];
}

interface StatusData {
    status: "running" | "done" | "crashed";
    currentTool?: string;
    currentArgs?: string;
    startTime: number;
    endTime?: number;
    turns: number;
    toolCalls: number;
    cost: number;
    model?: string;
    exitCode?: number;
    summary?: string;
    episode?: Episode;
    lastUpdate: number;
}

function parseEpisodeBlock(text: string): Episode | null {
    // Grab the LAST <episode> block (agent may quote the template)
    const allMatches = [...text.matchAll(/<episode>([\s\S]*?)<\/episode>/g)];
    if (allMatches.length === 0) return null;

    const block = allMatches[allMatches.length - 1][1];
    const statusMatch = block.match(/status:\s*(success|failure|blocked)/i);
    const summaryMatch = block.match(/summary:\s*(.+?)(?=\nfindings:|\nartifacts:|\nblockers:|\n*$)/is);

    return {
        status: (statusMatch?.[1]?.toLowerCase() as Episode["status"]) || "success",
        summary: summaryMatch?.[1]?.trim() || "",
        findings: parseList(block, "findings"),
        artifacts: parseList(block, "artifacts"),
        blockers: parseList(block, "blockers"),
    };
}

function parseList(block: string, field: string): string[] {
    const match = block.match(new RegExp(`${field}:\\s*\\n((?:\\s*-\\s*.+\\n?)*)`, "i"));
    if (!match) return [];
    return match[1].split("\n").map(line => line.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
}

export default function workerExtension(pi: ExtensionAPI) {
    let cwd = process.cwd();
    let status: StatusData = {
        status: "running",
        startTime: Date.now(),
        turns: 0,
        toolCalls: 0,
        cost: 0,
        lastUpdate: Date.now(),
    };

    function writeStatus(): void {
        const dir = path.join(cwd, STATUS_DIR);
        const file = path.join(dir, STATUS_FILE);
        try {
            fs.mkdirSync(dir, { recursive: true });
            status.lastUpdate = Date.now();
            fs.writeFileSync(file, JSON.stringify(status, null, 2), "utf-8");
        } catch {
            // Best effort — don't crash the worker over status writes
        }
    }

    // Inject the episode prompt so the agent writes structured output
    pi.on("before_agent_start", async (event) => {
        return {
            systemPrompt: (event.systemPrompt || "") + "\n\n" + EPISODE_PROMPT,
        };
    });

    pi.on("session_start", async (_event, ctx) => {
        cwd = ctx.cwd;
        writeStatus();
    });

    pi.on("tool_execution_start", async (event) => {
        status.currentTool = event.toolName;
        const args = event.args as Record<string, unknown>;
        if (event.toolName === "bash") {
            const cmd = (args.command as string) || "";
            status.currentArgs = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
        } else if (args.path) {
            status.currentArgs = args.path as string;
        } else {
            status.currentArgs = undefined;
        }
        status.toolCalls++;
        writeStatus();
    });

    pi.on("tool_execution_end", async () => {
        status.currentTool = undefined;
        status.currentArgs = undefined;
        writeStatus();
    });

    pi.on("turn_end", async (event) => {
        status.turns++;
        const msg = event.message as any;
        if (msg?.usage) {
            status.cost += msg.usage.cost?.total || 0;
        }
        if (msg?.model && !status.model) {
            status.model = msg.model;
        }
        writeStatus();
    });

    pi.on("agent_end", async (event, ctx) => {
        // Extract the last assistant text and parse the episode block
        let lastText = "";
        const messages = event.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i] as any;
            if (msg.role === "assistant") {
                for (const part of msg.content || []) {
                    if (part.type === "text") {
                        lastText = part.text;
                        break;
                    }
                }
                if (lastText) break;
            }
        }

        const episode = parseEpisodeBlock(lastText);

        let summary = episode?.summary || lastText;
        if (summary.length > 2000) {
            summary = summary.slice(0, 2000) + "...";
        }

        // Truncate raw text for status file (50KB max)
        let text = lastText;
        if (text.length > 50 * 1024) {
            text = text.slice(0, 50 * 1024) + "\n[truncated]";
        }

        status.status = "done";
        status.exitCode = 0;
        status.endTime = Date.now();
        status.summary = summary;
        (status as any).text = text;
        status.episode = episode || undefined;
        status.currentTool = undefined;
        status.currentArgs = undefined;
        writeStatus();

        ctx.shutdown();
    });

    pi.on("session_shutdown", async () => {
        if (status.status === "running") {
            status.status = "crashed";
            status.exitCode = 1;
            status.endTime = Date.now();
            status.summary = "Worker process terminated unexpectedly";
            writeStatus();
        }
    });
}
