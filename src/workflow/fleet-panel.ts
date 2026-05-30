import type { Theme } from "@earendil-works/pi-coding-agent";
import {
    matchesKey,
    Key,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import type { WorkflowRun, WorkflowAgentNode } from "./types.js";

// ── Navigation levels ────────────────────────────────────────────────

type PanelLevel = "runs" | "phases" | "agents" | "agent-detail";

interface PanelState {
    level: PanelLevel;
    selectedRunIndex: number;
    selectedPhaseIndex: number;
    selectedAgentIndex: number;
    scrollOffset: number;
}

function initialPanelState(): PanelState {
    return {
        level: "runs",
        selectedRunIndex: 0,
        selectedPhaseIndex: 0,
        selectedAgentIndex: 0,
        scrollOffset: 0,
    };
}

// ── Panel Component ──────────────────────────────────────────────────

export interface FleetPanelOptions {
    /** Callback when user requests action */
    onAction: (action: FleetAction) => void;
    /** Callback to close the panel */
    onClose: () => void;
}

export type FleetAction =
    | { type: "pause"; runId: string }
    | { type: "resume"; runId: string }
    | { type: "stop"; runId: string }
    | { type: "stopAgent"; runId: string; agentId: string }
    | { type: "attach"; runId: string; agentId: string }
    | { type: "message"; runId: string; agentId: string; text: string }
    | { type: "restartAgent"; runId: string; agentId: string };

export class FleetPanel {
    private state: PanelState = initialPanelState();
    private cachedWidth?: number;
    private cachedLines?: string[];
    private runs: WorkflowRun[] = [];

    constructor(
        private readonly theme: Theme,
        private readonly opts: FleetPanelOptions,
    ) {}

    /** Update runs data (called from outside when state changes) */
    updateRuns(runs: WorkflowRun[]): void {
        this.runs = runs;
        this.invalidate();
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) {
            if (this.state.level === "runs") {
                this.opts.onClose();
                return;
            }
            // Go back one level
            this.state.level = backtrack(this.state.level);
            this.state.scrollOffset = 0;
            this.invalidate();
            return;
        }

        if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
            this.drillIn();
            this.invalidate();
            return;
        }

        if (matchesKey(data, Key.up)) {
            this.moveSelection(-1);
            this.invalidate();
            return;
        }

        if (matchesKey(data, Key.down)) {
            this.moveSelection(1);
            this.invalidate();
            return;
        }

        // Context keys
        if (data === "p") {
            this.emitRunAction("pause");
            return;
        }
        if (data === "x") {
            if (this.state.level === "agents" || this.state.level === "agent-detail") {
                this.emitAgentAction("stopAgent");
            } else {
                this.emitRunAction("stop");
            }
            return;
        }
        if (data === "r") {
            if (this.state.level === "agents" || this.state.level === "agent-detail") {
                this.emitAgentAction("restartAgent");
            }
            return;
        }
        if (data === "a") {
            if (this.state.level === "agents" || this.state.level === "agent-detail") {
                this.emitAgentAction("attach");
            }
            return;
        }
    }

    render(width: number): string[] {
        if (this.cachedLines && this.cachedWidth === width) {
            return this.cachedLines;
        }

        const lines: string[] = [];

        switch (this.state.level) {
            case "runs":
                this.renderRuns(width, lines);
                break;
            case "phases":
                this.renderPhases(width, lines);
                break;
            case "agents":
                this.renderAgents(width, lines);
                break;
            case "agent-detail":
                this.renderAgentDetail(width, lines);
                break;
        }

        // Help line
        const help = this.renderHelp();
        lines.push("");
        lines.push(this.theme.fg("dim", help));

        this.cachedLines = lines;
        this.cachedWidth = width;
        return lines;
    }

    invalidate(): void {
        this.cachedWidth = undefined;
        this.cachedLines = undefined;
    }

    // ── Rendering ─────────────────────────────

    private renderRuns(width: number, lines: string[]): void {
        lines.push(this.theme.fg("accent", this.theme.bold("⏣ Spindle Fleet")));
        lines.push("");

        if (this.runs.length === 0) {
            lines.push(this.theme.fg("muted", "  No workflow runs."));
            return;
        }

        const visibleCount = Math.min(this.runs.length, 20);
        const startIdx = Math.max(0, Math.min(this.state.selectedRunIndex - 5, this.runs.length - visibleCount));
        const maxVisible = Math.min(visibleCount, width - 2);

        for (let i = startIdx; i < Math.min(startIdx + visibleCount, this.runs.length); i++) {
            const run = this.runs[i];
            const selected = i === this.state.selectedRunIndex;
            const prefix = selected ? "▸ " : "  ";
            const name = this.theme.fg("toolTitle", run.name);
            const summary = this.runSummary(run);
            const line = `${prefix}${this.colorStatus(run.status, this.sigil(run.status))} ${name} ${this.theme.fg("dim", summary)}`;
            lines.push(truncateToWidth(line, width));
        }
    }

    private renderPhases(width: number, lines: string[]): void {
        const run = this.runs[this.state.selectedRunIndex];
        if (!run) { this.state.level = "runs"; return; }

        lines.push(this.theme.fg("accent", `⏣ ${run.name}`) + " " + this.theme.fg("dim", `— ${this.runSummary(run)}`));
        lines.push("");

        if (run.phases.length === 0) {
            lines.push(this.theme.fg("muted", "  No phases defined."));
            return;
        }

        for (let i = 0; i < run.phases.length; i++) {
            const phase = run.phases[i];
            const selected = i === this.state.selectedPhaseIndex;
            const prefix = selected ? "▸ " : "  ";
            const done = phase.agents.filter((id: string) => {
                const a = run.agents[id];
                return a?.status === "completed" || a?.status === "cached";
            }).length;
            const phaseBar = this.bar(done, phase.agents.length, 10);
            const line = `${prefix}${this.colorStatus(phase.status, this.sigil(phase.status))} ${this.theme.bold(phase.title)} ${this.theme.fg("dim", `${done}/${phase.agents.length} ${phaseBar}`)}`;
            lines.push(truncateToWidth(line, width));
        }

        // Unphased agents
        const phased = new Set(run.phases.flatMap((p) => p.agents));
        const unphased = run.agentOrder.filter((id) => !phased.has(id));
        if (unphased.length > 0) {
            lines.push("");
            lines.push(this.theme.fg("dim", `  (${unphased.length} unphased agent${unphased.length === 1 ? "" : "s"})`));
        }
    }

    private renderAgents(width: number, lines: string[]): void {
        const run = this.runs[this.state.selectedRunIndex];
        if (!run) { this.state.level = "runs"; return; }

        const phase = run.phases[this.state.selectedPhaseIndex];
        if (!phase) { this.state.level = "phases"; return; }

        lines.push(this.theme.fg("accent", `⏣ ${run.name} › ${phase.title}`));
        lines.push("");

        const agentIds = phase.agents;
        if (agentIds.length === 0) {
            lines.push(this.theme.fg("muted", "  No agents in this phase."));
            return;
        }

        for (let i = 0; i < agentIds.length; i++) {
            const agent = run.agents[agentIds[i]];
            if (!agent) continue;
            const selected = i === this.state.selectedAgentIndex;
            const prefix = selected ? "▸ " : "  ";
            const dur = agent.durationMs ? ` ${(agent.durationMs / 1000).toFixed(1)}s` : "";
            const err = agent.error ? ` ${this.theme.fg("error", "⚠")}` : "";
            const label = `${agent.label}${dur}${err}`;
            const line = `${prefix}${this.colorStatus(agent.status, this.sigil(agent.status))} ${this.theme.fg("toolOutput", label)}`;
            lines.push(truncateToWidth(line, width));
        }
    }

    private renderAgentDetail(width: number, lines: string[]): void {
        const run = this.runs[this.state.selectedRunIndex];
        if (!run) { this.state.level = "runs"; return; }

        const phase = run.phases[this.state.selectedPhaseIndex];
        if (!phase) { this.state.level = "phases"; return; }

        const agentId = phase.agents[this.state.selectedAgentIndex];
        const agent = agentId ? run.agents[agentId] : undefined;
        if (!agent) { this.state.level = "agents"; return; }

        lines.push(this.theme.fg("accent", `⏣ ${run.name} › ${phase.title ?? "(unphased)"} › ${agent.label}`));
        lines.push("");

        lines.push(`  ${this.theme.fg("muted", "Status:")} ${this.colorStatus(agent.status, agent.status)}`);
        lines.push(`  ${this.theme.fg("muted", "ID:")} ${this.theme.fg("dim", agent.id)}`);

        if (agent.phase) {
            lines.push(`  ${this.theme.fg("muted", "Phase:")} ${agent.phase}`);
        }

        const startedAt = agent.startedAt
            ? new Date(agent.startedAt).toLocaleTimeString()
            : "—";
        const completedAt = agent.completedAt
            ? new Date(agent.completedAt).toLocaleTimeString()
            : "—";
        lines.push(`  ${this.theme.fg("muted", "Started:")} ${startedAt}`);
        lines.push(`  ${this.theme.fg("muted", "Completed:")} ${completedAt}`);

        if (agent.durationMs) {
            lines.push(`  ${this.theme.fg("muted", "Duration:")} ${(agent.durationMs / 1000).toFixed(1)}s`);
        }

        if (agent.error) {
            lines.push("");
            lines.push(`  ${this.theme.fg("error", `Error: ${agent.error}`)}`);
        }

        if (agent.promptPreview) {
            lines.push("");
            lines.push(`  ${this.theme.fg("muted", "Prompt:")}`);
            const previewLines = agent.promptPreview.split("\n").slice(0, 6);
            for (const pl of previewLines) {
                lines.push(`    ${this.theme.fg("dim", truncateToWidth(pl, width - 4))}`);
            }
        }

        if (agent.result !== undefined) {
            lines.push("");
            lines.push(`  ${this.theme.fg("muted", "Result:")}`);
            const resultText = typeof agent.result === "string"
                ? agent.result
                : JSON.stringify(agent.result, null, 2);
            const resultLines = resultText.split("\n").slice(0, 10);
            for (const rl of resultLines) {
                lines.push(`    ${this.theme.fg("dim", truncateToWidth(rl, width - 4))}`);
            }
            if (resultText.split("\n").length > 10) {
                lines.push(`    ${this.theme.fg("dim", "…")}`);
            }
        }
    }

    // ── Help text ──────────────────────

    private renderHelp(): string {
        switch (this.state.level) {
            case "runs":
                return "↑↓ navigate · Enter drill in · Esc close · p pause · x stop";
            case "phases":
                return "↑↓ navigate · Enter drill in · Esc back · p pause · x stop run";
            case "agents":
                return "↑↓ navigate · Enter detail · Esc back · x stop agent · a attach";
            case "agent-detail":
                return "Esc back · x stop agent · a attach · r restart";
        }
    }

    // ── Navigation ──────────────────────

    private drillIn(): void {
        switch (this.state.level) {
            case "runs": {
                if (this.runs.length === 0) return;
                const run = this.runs[this.state.selectedRunIndex];
                if (!run || run.phases.length === 0) return;
                this.state.level = "phases";
                this.state.selectedPhaseIndex = 0;
                this.state.scrollOffset = 0;
                break;
            }
            case "phases": {
                const run = this.runs[this.state.selectedRunIndex];
                if (!run) return;
                const phase = run.phases[this.state.selectedPhaseIndex];
                if (!phase || phase.agents.length === 0) return;
                this.state.level = "agents";
                this.state.selectedAgentIndex = 0;
                this.state.scrollOffset = 0;
                break;
            }
            case "agents": {
                this.state.level = "agent-detail";
                this.state.scrollOffset = 0;
                break;
            }
            case "agent-detail":
                // Already at deepest level
                break;
        }
    }

    private moveSelection(delta: number): void {
        switch (this.state.level) {
            case "runs": {
                const max = Math.max(0, this.runs.length - 1);
                this.state.selectedRunIndex = clamp(this.state.selectedRunIndex + delta, 0, max);
                break;
            }
            case "phases": {
                const run = this.runs[this.state.selectedRunIndex];
                const max = Math.max(0, (run?.phases.length ?? 0) - 1);
                this.state.selectedPhaseIndex = clamp(this.state.selectedPhaseIndex + delta, 0, max);
                break;
            }
            case "agents": {
                const run = this.runs[this.state.selectedRunIndex];
                const phase = run?.phases[this.state.selectedPhaseIndex];
                const max = Math.max(0, (phase?.agents.length ?? 0) - 1);
                this.state.selectedAgentIndex = clamp(this.state.selectedAgentIndex + delta, 0, max);
                break;
            }
            case "agent-detail":
                // No vertical navigation at detail level (scroll future)
                break;
        }
    }

    // ── Action emission ─────────────────

    private emitRunAction(actionType: "pause" | "stop" | "resume"): void {
        const run = this.runs[this.state.selectedRunIndex];
        if (!run) return;
        if (actionType === "pause" && run.status === "running") {
            this.opts.onAction({ type: "pause", runId: run.id });
        } else if (actionType === "pause" && run.status === "paused") {
            this.opts.onAction({ type: "resume", runId: run.id });
        } else if (actionType === "stop") {
            this.opts.onAction({ type: "stop", runId: run.id });
        }
    }

    private emitAgentAction(actionType: "stopAgent" | "restartAgent" | "attach"): void {
        const run = this.runs[this.state.selectedRunIndex];
        if (!run) return;
        const phase = run.phases[this.state.selectedPhaseIndex];
        if (!phase) return;
        const agentId = phase.agents[this.state.selectedAgentIndex];
        if (!agentId) return;
        this.opts.onAction({ type: actionType, runId: run.id, agentId } as FleetAction);
    }

    // ── Styling helpers ─────────────────

    private sigil(status: string): string {
        switch (status) {
            case "done": case "completed": case "cached": return "⏣";
            case "failed": case "cancelled": return "✦";
            case "running": case "starting": return "◎";
            case "queued": case "waiting": return "○";
            default: return "·";
        }
    }

    private colorStatus(status: string, text: string): string {
        switch (status) {
            case "done": case "completed": case "cached": return this.theme.fg("success", text);
            case "failed": case "cancelled": return this.theme.fg("error", text);
            case "running": case "starting": case "paused": return this.theme.fg("warning", text);
            default: return this.theme.fg("muted", text);
        }
    }

    private runSummary(run: WorkflowRun): string {
        const done = run.agentOrder.filter((id) => {
            const s = run.agents[id]?.status;
            return s === "completed" || s === "cached";
        }).length;
        const total = run.agentOrder.length;
        const cost = run.usage.cost ? ` · $${run.usage.cost.toFixed(4)}` : "";
        const elapsed = ((run.completedAt ?? Date.now()) - run.startedAt) / 1000;
        return `${done}/${total}${cost} · ${elapsed.toFixed(1)}s`;
    }

    private bar(done: number, total: number, width: number): string {
        if (total === 0) return "";
        const filled = Math.round((done / total) * width);
        return "█".repeat(filled) + "░".repeat(width - filled);
    }
}

// ── Utilities ─────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function backtrack(level: PanelLevel): PanelLevel {
    switch (level) {
        case "phases": return "runs";
        case "agents": return "phases";
        case "agent-detail": return "agents";
        default: return "runs";
    }
}