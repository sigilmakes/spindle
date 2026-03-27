/**
 * Worker Extension — loaded by pi subagent processes spawned by spindle.
 *
 * Hooks pi lifecycle events and writes structured status to
 * .spindle/status.json in the working directory. The main session's
 * poller reads these files to drive the dashboard and notifications.
 *
 * Calls ctx.shutdown() when the agent finishes so the process exits
 * cleanly instead of waiting for user input.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATUS_DIR = ".spindle";
const STATUS_FILE = "status.json";

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
    lastUpdate: number;
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

    pi.on("session_start", async (_event, ctx) => {
        cwd = ctx.cwd;
        writeStatus();
    });

    pi.on("tool_execution_start", async (event) => {
        status.currentTool = event.toolName;
        // Extract a useful preview from args
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
        // Extract summary from the last assistant message
        let summary = "";
        const messages = event.messages || [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i] as any;
            if (msg.role === "assistant") {
                for (const part of msg.content || []) {
                    if (part.type === "text") {
                        summary = part.text;
                        break;
                    }
                }
                if (summary) break;
            }
        }

        // Truncate summary to something reasonable
        if (summary.length > 2000) {
            summary = summary.slice(0, 2000) + "...";
        }

        status.status = "done";
        status.exitCode = 0;
        status.endTime = Date.now();
        status.summary = summary;
        status.currentTool = undefined;
        status.currentArgs = undefined;
        writeStatus();

        // Exit the process cleanly
        ctx.shutdown();
    });

    pi.on("session_shutdown", async () => {
        // If we haven't written a "done" status, mark as crashed
        if (status.status === "running") {
            status.status = "crashed";
            status.exitCode = 1;
            status.endTime = Date.now();
            status.summary = "Worker process terminated unexpectedly";
            writeStatus();
        }
    });
}
