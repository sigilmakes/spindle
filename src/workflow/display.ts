import type { Theme } from "@earendil-works/pi-coding-agent";
import type { WorkflowRun } from "./types.js";
import { parseWorkflowMeta } from "./meta.js";

// ── Snapshot types ──────────────────────────────────────────────────────

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

// ── Create snapshot from meta (before run starts) ─────────────────────

export function createSnapshotFromMeta(script: string | undefined, name: string | undefined, cwd: string): WorkflowSnapshot {
    let metaName = name ?? "workflow";
    let description = "";
    let phases: string[] = [];

    if (script) {
        try {
            const meta = parseWorkflowMeta(script);
            metaName = meta.name;
            description = meta.description;
            phases = meta.phases?.map((p) => p.title) ?? [];
        } catch { /* use defaults */ }
    }

    return {
        name: metaName,
        description,
        phases,
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
    };
}

// ── Incremental snapshot mutations ─────────────────────────────────────

export function pushAgentStart(
    snapshot: WorkflowSnapshot,
    event: { id: string; label: string; phase?: string; prompt: string },
): WorkflowSnapshot {
    return {
        ...snapshot,
        agents: [...snapshot.agents, {
            id: snapshot.agents.length + 1,
            label: event.label ?? event.id,
            phase: event.phase,
            status: "running" as const,
        }],
        agentCount: snapshot.agents.length + 1,
        runningCount: snapshot.runningCount + 1,
        currentPhase: event.phase ?? snapshot.currentPhase,
    };
}

export function pushAgentEnd(
    snapshot: WorkflowSnapshot,
    event: { id: string; label: string; phase?: string; result: unknown },
): WorkflowSnapshot {
    const agents = snapshot.agents.map((a) => {
        // Match by label + running status (from end of array for correctness)
        if (a.label === event.label && a.status === "running") {
            return {
                ...a,
                status: (event.result === null ? "error" : "done") as WorkflowAgentSnapshot["status"],
                resultPreview: event.result != null ? previewText(event.result) : undefined,
                error: event.result === null ? "failed" : undefined,
            };
        }
        return a;
    });
    const runningCount = agents.filter((a) => a.status === "running").length;
    const doneCount = agents.filter((a) => a.status === "done" || a.status === "cached").length;
    const errorCount = agents.filter((a) => a.status === "error").length;
    return { ...snapshot, agents, runningCount, doneCount, errorCount };
}

export function pushPhase(snapshot: WorkflowSnapshot, title: string): WorkflowSnapshot {
    const phases = snapshot.phases.includes(title) ? snapshot.phases : [...snapshot.phases, title];
    return { ...snapshot, phases, currentPhase: title };
}

export function pushLog(snapshot: WorkflowSnapshot, message: string): WorkflowSnapshot {
    // Logs are stored in the run, not snapshot — snapshot is just for display.
    // We track a small recent log buffer here for the widget.
    return snapshot;
}

export function finalizeSnapshot(snapshot: WorkflowSnapshot, run: WorkflowRun): WorkflowSnapshot {
    return {
        ...snapshot,
        name: run.name,
        description: run.description,
        durationMs: run.completedAt ? run.completedAt - run.startedAt : undefined,
        result: run.result,
        agents: snapshot.agents.map((a) =>
            a.status === "running" ? { ...a, status: "skipped" as const } : a
        ),
        runningCount: 0,
    };
}

function previewText(value: unknown, max = 60): string {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "";
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── Create snapshot from a completed run ───────────────────────────────

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
                ? previewText(a.result)
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

// ── Streaming display — bridges onUpdate from tool to live chat output ─

export interface StreamingDisplay {
    stream(text: string, run: WorkflowRun): void;
    refresh(snapshot: WorkflowSnapshot): void;
    complete(snapshot: WorkflowSnapshot, run: WorkflowRun): void;
}

export function createStreamingDisplay(
    toolOnUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
    ctx: { ui: any; hasUI?: boolean },
    initialSnapshot: WorkflowSnapshot,
): StreamingDisplay {
    let currentSnapshot = initialSnapshot;

    const emit = (snapshot: WorkflowSnapshot, completed: boolean) => {
        const text = renderSnapshotText(snapshot, completed);
        toolOnUpdate?.({
            content: [{ type: "text", text }],
            details: snapshot,
        });

        // Also update the fleet widget
        if (ctx.hasUI && ctx.ui) {
            const activeRuns = [snapshot]; // could merge with other active runs
            const theme = ctx.ui.theme;
            const widgetLines = renderFleetWidget(activeRuns, theme, { maxRuns: 5, maxAgentsPerRun: 6 });
            ctx.ui.setWidget("spindle-fleet", widgetLines, { placement: "aboveEditor" });
        }
    };

    return {
        stream(text, run) {
            // Called from launchWorkflow's onUpdate — full run text
            toolOnUpdate?.({
                content: [{ type: "text", text }],
                details: { kind: "workflow", run },
            });
        },
        refresh(snapshot) {
            currentSnapshot = snapshot;
            emit(snapshot, false);
        },
        complete(snapshot, run) {
            currentSnapshot = snapshot;
            emit(snapshot, true);
        },
    };
}

// ── Snapshot text rendering (for live tool result area) ────────────────

export function renderSnapshotText(snapshot: WorkflowSnapshot, completed: boolean): string {
    const header = completed ? "Workflow completed" : "Workflow running";
    const state = snapshot.errorCount > 0 ? `, ${snapshot.errorCount} ⚠` : snapshot.runningCount > 0 ? `, ${snapshot.runningCount} ◎` : "";
    const lines: string[] = [];
    lines.push(`${header}: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state})`);

    const phaseNames = snapshot.phases.length
        ? snapshot.phases
        : unique(snapshot.agents.map((a) => a.phase).filter(Boolean) as string[]);
    const rendered = new Set<WorkflowAgentSnapshot>();

    for (const phase of phaseNames) {
        const agents = snapshot.agents.filter((a) => a.phase === phase);
        for (const a of agents) rendered.add(a);
        const done = agents.filter((a) => a.status === "done" || a.status === "cached").length;
        const running = agents.filter((a) => a.status === "running").length;
        const errors = agents.filter((a) => a.status === "error").length;
        const skipped = agents.filter((a) => a.status === "skipped").length;
        const complete = agents.length > 0 && done + errors + skipped === agents.length;
        const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
        lines.push(`  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`);

        const visible = agents.slice(-4);
        for (const agent of visible) {
            lines.push(`    #${agent.id} ${agentSigil(agent.status)} ${agent.label}${agent.error ? ` ⚠ ${agent.error}` : ""}${agent.resultPreview ? ` — ${agent.resultPreview}` : ""}`);
        }
        if (agents.length > visible.length) lines.push(`    … ${agents.length - visible.length} earlier agents`);
    }

    const unphased = snapshot.agents.filter((a) => !rendered.has(a));
    if (unphased.length) {
        lines.push("  (unphased)");
        for (const agent of unphased.slice(-4)) {
            lines.push(`    #${agent.id} ${agentSigil(agent.status)} ${agent.label}`);
        }
    }

    if (snapshot.durationMs) {
        lines.push(`  ${completed ? "completed" : "elapsed"} in ${(snapshot.durationMs / 1000).toFixed(1)}s`);
    }

    return lines.join("\n");
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

// ── Fleet widget rendering ────────────────────────────────────────────

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

    const state = totalErrors > 0 ? `${totalErrors} ⚠` : totalRunning > 0 ? `${totalRunning} ◎` : "idle";
    lines.push(`${theme.fg("accent", "⏣ Spindle")} ${theme.fg("dim", `${snapshots.length} run${snapshots.length === 1 ? "" : "s"} · ${totalDone}/${totalAgents} done · ${state}`)}`);

    for (const snapshot of snapshots.slice(0, maxRuns)) {
        const runState = snapshot.runningCount > 0 ? "◎" : snapshot.errorCount > 0 ? "✦" : "⏣";
        const bar = fleetBar(snapshot.doneCount, snapshot.agentCount, snapshot.errorCount, 12);
        const elapsed = snapshot.durationMs ? ` ${(snapshot.durationMs / 1000).toFixed(1)}s` : "";
        lines.push(`  ${theme.fg("muted", runState)} ${theme.fg("toolTitle", snapshot.name)} ${theme.fg("dim", bar)} ${theme.fg("dim", `${snapshot.doneCount}/${snapshot.agentCount}${elapsed}`)}`);

        if (snapshot.agents.length <= maxAgents) {
            for (const agent of snapshot.agents) {
                const icon = agentSigil(agent.status);
                const result = showResults && agent.resultPreview ? ` ${theme.fg("dim", `— ${agent.resultPreview}`)}` : "";
                const err = agent.error ? ` ${theme.fg("error", "⚠")}` : "";
                lines.push(`    ${icon} ${agent.label}${err}${result}`);
            }
        } else {
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
                const st = counts.running > 0 ? " ◎" : counts.error > 0 ? " ✦" : "";
                lines.push(`    ${theme.fg("dim", label)} ${phaseBar} ${counts.done}/${counts.total}${st}`);
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