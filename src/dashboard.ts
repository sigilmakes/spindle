/**
 * Dashboard — compact status widget showing all active workers.
 *
 * Rendered via ctx.ui.setWidget() in the main session.
 *
 * ┌─ Workers ──────────────────────────────────────────────┐
 * │ w0 refactor-auth  ⏳ 2m14s  edit src/auth.ts           │
 * │ w1 add-tests      ⏳ 1m52s  bash: npm test             │
 * │ w2 fix-types      ✓  0m43s  done · spindle/w2          │
 * └────────────────────────────────────────────────────────┘
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkerHandle, WorkerStatusFile } from "./workers.js";

const STATUS_DIR = ".spindle";
const STATUS_FILE = "status.json";

function readStatusFile(worktreeDir: string): WorkerStatusFile | null {
    const filePath = path.join(worktreeDir, STATUS_DIR, STATUS_FILE);
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as WorkerStatusFile;
    } catch {
        return null;
    }
}

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

export function renderDashboard(workers: Map<string, WorkerHandle>): string[] {
    if (workers.size === 0) return [];

    const lines: string[] = [];
    const runningCount = [...workers.values()].filter(h => !(h as any).resolved).length;
    const doneCount = workers.size - runningCount;

    lines.push(`─ Workers (${runningCount} running, ${doneCount} done) ─`);

    for (const [id, handle] of workers) {
        const sf = readStatusFile(handle.worktree);
        const resolved = (handle as any).resolved;
        const elapsed = Date.now() - handle.startTime;

        let icon: string;
        let statusText: string;

        if (resolved) {
            const status = sf?.status || "crashed";
            if (status === "done" && sf?.exitCode === 0) {
                icon = "✓";
                statusText = `done · ${handle.branch}`;
            } else if (status === "done") {
                icon = "✗";
                statusText = `failed · ${handle.branch}`;
            } else {
                icon = "✗";
                statusText = "crashed";
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
        lines.push(`  ${icon} ${id} ${taskPreview}  ${duration}  ${statusText}`);
    }

    return lines;
}
