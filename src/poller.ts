/**
 * Status Poller — polls worker status files and drives dashboard + notifications.
 *
 * Reads .spindle/status.json from each active worker's worktree every 2s.
 * Detects state changes and fires callbacks for dashboard updates and
 * completion notifications.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
    getActiveWorkers,
    type WorkerHandle,
    type WorkerResult,
    type WorkerStatusFile,
} from "./workers.js";

const POLL_INTERVAL_MS = 2000;
const STATUS_DIR = ".spindle";
const STATUS_FILE = "status.json";

export interface PollerCallbacks {
    onUpdate: (workers: Map<string, WorkerHandle>) => void;
    onWorkerDone: (handle: WorkerHandle, result: WorkerResult) => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollerCallbacks: PollerCallbacks | null = null;

/** Cache of last-seen status per worker to detect changes. */
const lastStatus = new Map<string, string>();

function readStatusFile(worktreeDir: string): WorkerStatusFile | null {
    const filePath = path.join(worktreeDir, STATUS_DIR, STATUS_FILE);
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as WorkerStatusFile;
    } catch {
        return null;
    }
}

function tmuxSessionExists(session: string): boolean {
    try {
        execSync(`tmux has-session -t ${JSON.stringify(session)}`, { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function buildResult(handle: WorkerHandle, sf: WorkerStatusFile): WorkerResult {
    const episode = sf.episode;
    return {
        status: episode?.status === "success" ? "success"
            : episode?.status === "blocked" ? "failure"
            : sf.exitCode === 0 ? "success" : "failure",
        summary: episode?.summary || sf.summary || "",
        findings: episode?.findings || [],
        artifacts: episode?.artifacts || [],
        blockers: episode?.blockers || [],
        branch: handle.branch,
        worktree: handle.worktree,
        exitCode: sf.exitCode ?? -1,
        turns: sf.turns,
        toolCalls: sf.toolCalls,
        cost: sf.cost,
        model: sf.model || "unknown",
        durationMs: (sf.endTime || Date.now()) - sf.startTime,
    };
}

function pollOnce(): void {
    const workers = getActiveWorkers();
    if (workers.size === 0) {
        stopPoller();
        return;
    }

    let anyChanged = false;

    for (const [id, handle] of workers) {
        // Skip already resolved workers
        if ((handle as any).resolved) continue;

        const sf = readStatusFile(handle.worktree);
        const statusKey = sf ? `${sf.status}:${sf.lastUpdate}:${sf.currentTool}` : "null";
        const prevKey = lastStatus.get(id);

        if (statusKey !== prevKey) {
            lastStatus.set(id, statusKey);
            anyChanged = true;
        }

        if (sf && (sf.status === "done" || sf.status === "crashed")) {
            const result = buildResult(handle, sf);
            (handle as any)._resolve(result);
            pollerCallbacks?.onWorkerDone(handle, result);
            anyChanged = true;
        } else if (!sf && !tmuxSessionExists(handle.session)) {
            // No status file and tmux session is dead — crashed before writing status
            const result: WorkerResult = {
                status: "failure",
                summary: "Worker process died without writing status",
                findings: [],
                artifacts: [],
                blockers: [],
                branch: handle.branch,
                worktree: handle.worktree,
                exitCode: -1,
                turns: 0,
                toolCalls: 0,
                cost: 0,
                model: "unknown",
                durationMs: Date.now() - handle.startTime,
            };
            (handle as any)._resolve(result);
            pollerCallbacks?.onWorkerDone(handle, result);
            anyChanged = true;
        }
    }

    if (anyChanged) {
        pollerCallbacks?.onUpdate(workers);
    }

    // If all workers are resolved, stop polling
    let allDone = true;
    for (const handle of workers.values()) {
        if (!(handle as any).resolved) {
            allDone = false;
            break;
        }
    }
    if (allDone) {
        // Emit one final update, then stop after a delay
        pollerCallbacks?.onUpdate(workers);
        setTimeout(() => {
            const currentWorkers = getActiveWorkers();
            let stillAllDone = true;
            for (const h of currentWorkers.values()) {
                if (!(h as any).resolved) { stillAllDone = false; break; }
            }
            if (stillAllDone) stopPoller();
        }, 5000);
    }
}

export function startPoller(cb: PollerCallbacks): void {
    pollerCallbacks = cb;
    if (!pollTimer) {
        pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
        // Run immediately on start
        pollOnce();
    }
}

export function stopPoller(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    lastStatus.clear();
}

export function isPollerRunning(): boolean {
    return pollTimer !== null;
}
