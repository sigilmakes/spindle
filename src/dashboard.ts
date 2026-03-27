/**
 * Dashboard — compact status widget showing all active subagents.
 *
 * Rendered via ctx.ui.setWidget() in the main session.
 */

import { readStatusFile, type SubagentHandle } from "./workers.js";

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m${secs.toString().padStart(2, "0")}s`;
}

function truncateTask(task: string, maxLen: number = 30): string {
    if (task.length <= maxLen) return task;
    return task.slice(0, maxLen - 3) + "...";
}

export function renderDashboard(subagents: Map<string, SubagentHandle>): string[] {
    if (subagents.size === 0) return [];

    const lines: string[] = [];
    const runningCount = [...subagents.values()].filter(h => !(h as any).resolved).length;
    const doneCount = subagents.size - runningCount;

    lines.push(`─ Subagents (${runningCount} running, ${doneCount} done) ─`);

    for (const [, handle] of subagents) {
        const statusDir = (handle as any).statusDir as string;
        const sf = readStatusFile(statusDir);
        const resolved = (handle as any).resolved;
        const elapsed = Date.now() - handle.startTime;

        let icon: string;
        let statusText: string;

        if (resolved) {
            const s = sf?.status || "crashed";
            if (s === "done" && sf?.exitCode === 0) {
                icon = "✓";
                statusText = handle.branch ? `done · ${handle.branch}` : "done";
            } else {
                icon = "✗";
                statusText = s === "crashed" ? "crashed" : "failed";
            }
        } else if (sf?.currentTool) {
            icon = "⏳";
            const toolInfo = sf.currentArgs
                ? `${sf.currentTool} ${sf.currentArgs}`
                : sf.currentTool;
            statusText = toolInfo.length > 40 ? toolInfo.slice(0, 37) + "..." : toolInfo;
        } else {
            icon = "⏳";
            statusText = "running";
        }

        const duration = formatDuration(sf?.endTime ? sf.endTime - sf.startTime : elapsed);
        const taskPreview = truncateTask(handle.task);
        lines.push(`  ${icon} ${handle.id} ${taskPreview}  ${duration}  ${statusText}`);
    }

    return lines;
}
