import type { Theme } from "@earendil-works/pi-coding-agent";
import type { WorkflowRun } from "./types.js";

export interface WorkflowSnapshot {
    name: string;
    description?: string;
    phases: string[];
    currentPhase?: string;
    agents: WorkflowAgentSnapshot[];
    agentCount: number;
    runningCount: number;
    doneCount: number;
    errorCount: number;
    durationMs?: number;
    result?: unknown;
}

export interface WorkflowAgentSnapshot {
    id: number;
    label: string;
    phase?: string;
    status: "queued" | "running" | "done" | "error" | "skipped" | "cached";
    resultPreview?: string;
    error?: string;
}

export function createSnapshot(run: WorkflowRun): WorkflowSnapshot {
    const agents: WorkflowAgentSnapshot[] = run.agentOrder.map((id, index) => {
        const a = run.agents[id];
        return {
            id: index + 1,
            label: a.label,
            phase: a.phase,
            status: agentStatusToSnapshot(a.status),
            error: a.error,
            resultPreview: a.result !== undefined
                ? (typeof a.result === "string" ? a.result.slice(0, 60) : JSON.stringify(a.result).slice(0, 60))
                : undefined,
        };
    });

    return {
        name: run.name,
        description: run.description,
        phases: run.phases.map((p) => p.title),
        currentPhase: run.phases.find((p) => p.status === "running")?.title,
        agents,
        agentCount: agents.length,
        runningCount: agents.filter((a) => a.status === "running").length,
        doneCount: agents.filter((a) => a.status === "done" || a.status === "cached").length,
        errorCount: agents.filter((a) => a.status === "error").length,
        durationMs: run.completedAt ? run.completedAt - run.startedAt : undefined,
        result: run.result,
    };
}

function agentStatusToSnapshot(status: string): WorkflowAgentSnapshot["status"] {
    switch (status) {
        case "completed": return "done";
        case "cached": return "cached";
        case "failed": return "error";
        case "cancelled": return "skipped";
        case "running": case "starting": return "running";
        default: return "queued";
    }
}

export function renderFleetWidget(
    snapshots: WorkflowSnapshot[],
    theme: Theme,
    opts: { maxRuns?: number; maxAgentsPerRun?: number; showResultPreviews?: boolean } = {},
): string[] {
    const maxRuns = opts.maxRuns ?? 8;
    const maxAgents = opts.maxAgentsPerRun ?? 4;
    const showResults = opts.showResultPreviews ?? false;

    const lines: string[] = [];

    if (snapshots.length === 0) {
        lines.push(theme.fg("muted", "No active workflows"));
        return lines;
    }

    const totalAgents = snapshots.reduce((s, r) => s + r.agentCount, 0);
    const totalRunning = snapshots.reduce((s, r) => s + r.runningCount, 0);
    const totalDone = snapshots.reduce((s, r) => s + r.doneCount, 0);
    const totalErrors = snapshots.reduce((s, r) => s + r.errorCount, 0);

    // Fleet header
    const state = totalErrors > 0 ? `${totalErrors} ⚠` : totalRunning > 0 ? `${totalRunning} ◎` : "idle";
    lines.push(`${theme.fg("accent", "⏣ Spindle")} ${theme.fg("dim", `${snapshots.length} run${snapshots.length === 1 ? "" : "s"} · ${totalDone}/${totalAgents} done · ${state}`)}`);

    // Per-run compact lines
    for (const snapshot of snapshots.slice(0, maxRuns)) {
        const runState = snapshot.runningCount > 0 ? "◎" : snapshot.errorCount > 0 ? "✦" : "⏣";
        const bar = fleetBar(snapshot.doneCount, snapshot.agentCount, snapshot.errorCount, 12);
        const elapsed = snapshot.durationMs ? ` ${(snapshot.durationMs / 1000).toFixed(1)}s` : "";
        lines.push(`  ${theme.fg("muted", runState)} ${theme.fg("toolTitle", snapshot.name)} ${theme.fg("dim", bar)} ${theme.fg("dim", `${snapshot.doneCount}/${snapshot.agentCount}${elapsed}`)}`);

        // Agent condensation for fleet view
        if (snapshot.agents.length <= maxAgents) {
            for (const agent of snapshot.agents) {
                const icon = agentSigil(agent.status);
                const result = showResults && agent.resultPreview ? ` ${theme.fg("dim", `— ${agent.resultPreview}`)}` : "";
                const err = agent.error ? ` ${theme.fg("error", `⚠`)}` : "";
                lines.push(`    ${icon} ${agent.label}${err}${result}`);
            }
        } else {
            // Aggregated counts per phase
            const byPhase = new Map<string, { done: number; running: number; error: number; total: number }>();
            for (const agent of snapshot.agents) {
                const phase = agent.phase ?? "";
                const counts = byPhase.get(phase) ?? { done: 0, running: 0, error: 0, total: 0 };
                counts.total++;
                if (agent.status === "done" || agent.status === "cached") counts.done++;
                else if (agent.status === "running") counts.running++;
                else if (agent.status === "error") counts.error++;
                byPhase.set(phase, counts);
            }
            for (const [phase, counts] of byPhase) {
                const phaseBar = fleetBar(counts.done, counts.total, counts.error, 8);
                const label = phase ? phase : "(all)";
                const state = counts.running > 0 ? " ◎" : counts.error > 0 ? " ✦" : "";
                lines.push(`    ${theme.fg("dim", label)} ${phaseBar} ${counts.done}/${counts.total}${state}`);
            }
        }
    }

    if (snapshots.length > maxRuns) {
        lines.push(`  ${theme.fg("dim", `… ${snapshots.length - maxRuns} more runs`)}`);
    }

    return lines;
}

function agentSigil(status: string): string {
    switch (status) {
        case "done": case "cached": return "⏣";
        case "error": return "✦";
        case "running": return "◎";
        case "skipped": return "⊘";
        default: return "○";
    }
}

function fleetBar(done: number, total: number, errors: number, width: number): string {
    if (total === 0) return "";
    const doneLen = Math.round((done / total) * width);
    const errorLen = Math.round((errors / total) * width);
    const remainLen = Math.max(0, width - doneLen - errorLen);
    return "█".repeat(doneLen) + "▓".repeat(errorLen) + "░".repeat(remainLen);
}

export function renderStatusLine(snapshots: WorkflowSnapshot[], theme: Theme): string {
    if (snapshots.length === 0) return "";
    const totalAgents = snapshots.reduce((s, r) => s + r.agentCount, 0);
    const totalRunning = snapshots.reduce((s, r) => s + r.runningCount, 0);
    const totalDone = snapshots.reduce((s, r) => s + r.doneCount, 0);
    if (totalRunning > 0) {
        return `⏣ ${totalRunning} running, ${totalDone}/${totalAgents} done`;
    }
    return `⏣ ${totalDone}/${totalAgents} done`;
}