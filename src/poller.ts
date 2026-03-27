/**
 * Status Poller — polls subagent status files and drives dashboard + notifications.
 */

import {
    getActiveSubagents, readStatusFile, isTmuxPaneAlive,
    type SubagentHandle, type AgentResult, type StatusFile,
} from "./workers.js";

const POLL_INTERVAL_MS = 2000;

export interface PollerCallbacks {
    onUpdate: (subagents: Map<string, SubagentHandle>) => void;
    onDone: (handle: SubagentHandle, result: AgentResult) => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollerCallbacks: PollerCallbacks | null = null;
const lastStatus = new Map<string, string>();

function buildResult(handle: SubagentHandle, sf: StatusFile): AgentResult {
    const ep = sf.episode;
    return {
        status: ep?.status === "success" ? "success"
            : ep?.status === "blocked" ? "blocked"
            : sf.exitCode === 0 ? "success" : "failure",
        summary: ep?.summary || sf.summary || "",
        findings: ep?.findings || [],
        artifacts: ep?.artifacts || [],
        blockers: ep?.blockers || [],
        text: sf.text || sf.summary || "",
        ok: (ep?.status || (sf.exitCode === 0 ? "success" : "failure")) === "success",
        cost: sf.cost,
        model: sf.model || "unknown",
        turns: sf.turns,
        toolCalls: sf.toolCalls,
        durationMs: (sf.endTime || Date.now()) - sf.startTime,
        exitCode: sf.exitCode ?? -1,
        branch: handle.branch,
        worktree: handle.worktree,
    };
}

function crashResult(handle: SubagentHandle): AgentResult {
    return {
        status: "failure",
        summary: "Subagent process died without writing status",
        findings: [],
        artifacts: [],
        blockers: [],
        text: "",
        ok: false,
        cost: 0,
        model: "unknown",
        turns: 0,
        toolCalls: 0,
        durationMs: Date.now() - handle.startTime,
        exitCode: -1,
        branch: handle.branch,
        worktree: handle.worktree,
    };
}

function pollOnce(): void {
    const subagents = getActiveSubagents();
    if (subagents.size === 0) {
        stopPoller();
        return;
    }

    let anyChanged = false;

    for (const [id, handle] of subagents) {
        if ((handle as any).resolved) continue;

        const statusDir = (handle as any).statusDir as string;
        const sf = readStatusFile(statusDir);
        const statusKey = sf ? `${sf.status}:${sf.lastUpdate}:${sf.currentTool}` : "null";
        const prevKey = lastStatus.get(id);

        if (statusKey !== prevKey) {
            lastStatus.set(id, statusKey);
            anyChanged = true;
        }

        if (sf && (sf.status === "done" || sf.status === "crashed")) {
            const result = buildResult(handle, sf);
            (handle as any)._resolve(result);
            pollerCallbacks?.onDone(handle, result);
            anyChanged = true;
        } else if (!isTmuxPaneAlive(handle.session)) {
            // Pi process is dead (session gone or fell back to shell)
            // but status file never got a terminal status — treat as crash
            const result = sf
                ? buildResult(handle, { ...sf, status: "crashed", exitCode: -1, endTime: Date.now() })
                : crashResult(handle);
            (handle as any)._resolve(result);
            pollerCallbacks?.onDone(handle, result);
            anyChanged = true;
        }
    }

    if (anyChanged) {
        pollerCallbacks?.onUpdate(subagents);
    }

    // Stop polling when all resolved
    let allDone = true;
    for (const handle of subagents.values()) {
        if (!(handle as any).resolved) { allDone = false; break; }
    }
    if (allDone) {
        pollerCallbacks?.onUpdate(subagents);
        setTimeout(() => {
            const current = getActiveSubagents();
            let stillDone = true;
            for (const h of current.values()) {
                if (!(h as any).resolved) { stillDone = false; break; }
            }
            if (stillDone) stopPoller();
        }, 5000);
    }
}

export function startPoller(cb: PollerCallbacks): void {
    pollerCallbacks = cb;
    if (!pollTimer) {
        pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
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
