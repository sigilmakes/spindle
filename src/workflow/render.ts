import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { WorkflowRun } from "./types.js";
import { summarizeWorkflowRun } from "./runtime.js";

export interface SpindleWorkflowDetails {
    kind: "workflow" | "workflow-list" | "workflow-status";
    run?: WorkflowRun;
    runs?: WorkflowRun[];
    library?: Array<{ name: string; description: string; whenToUse?: string; scope: string }>;
}

const SIGIL: Record<string, string> = {
    done: "⏣", completed: "⏣", cached: "◈",
    failed: "✦", cancelled: "⊘",
    running: "◎", starting: "◎",
    queued: "○", waiting: "◌",
};
const DEFAULT_SIGIL = "·";

function sigil(status: string): string {
    return SIGIL[status] ?? DEFAULT_SIGIL;
}

function colorSigil(status: string, theme: Theme): string {
    const s = sigil(status);
    switch (status) {
        case "done": case "completed": case "cached": return theme.fg("success", s);
        case "failed": case "cancelled": return theme.fg("error", s);
        case "running": case "starting": return theme.fg("warning", s);
        default: return theme.fg("muted", s);
    }
}

function bar(done: number, total: number, width: number = 16): string {
    if (total === 0) return "";
    const filled = Math.round((done / total) * width);
    const empty = width - filled;
    return "█".repeat(filled) + "░".repeat(empty);
}

export function formatWorkflowRun(run: WorkflowRun, theme: Theme, expanded: boolean = false): string {
    const lines: string[] = [];

    // Header: sigil + name + id + one-line summary
    lines.push(`${colorSigil(run.status, theme)} ${theme.fg("toolTitle", theme.bold(run.name))} ${theme.fg("dim", run.id)}`);
    lines.push(`  ${theme.fg("muted", run.description)}`);

    // Compact status line
    const agentDone = run.agentOrder.filter((id) => {
        const s = run.agents[id]?.status;
        return s === "completed" || s === "cached";
    }).length;
    const agentTotal = run.agentOrder.length;
    const cost = run.usage.cost ? ` · $${run.usage.cost.toFixed(4)}` : "";
    const elapsed = ((run.completedAt ?? Date.now()) - run.startedAt) / 1000;
    const statusLine = `${run.status} · ${agentDone}/${agentTotal}${cost} · ${elapsed.toFixed(1)}s`;
    lines.push(`  ${theme.fg("accent", statusLine)}`);

    // Progress bar for agents
    if (agentTotal > 0) {
        const done = run.agentOrder.filter((id) => {
            const s = run.agents[id]?.status;
            return s === "completed" || s === "cached" || s === "failed" || s === "cancelled";
        }).length;
        lines.push(`  ${theme.fg("dim", bar(done, agentTotal))} ${theme.fg("dim", `${done}/${agentTotal}`)}`);
    }

    // Error block
    if (run.error) {
        lines.push(`  ${theme.fg("error", `⚠ ${run.error.name}: ${run.error.message}`)}`);
    }

    // Failures — terse count, expandable
    if (run.failures.length > 0) {
        lines.push(`  ${theme.fg("error", `⚠ ${run.failures.length} failure${run.failures.length === 1 ? "" : "s"}`)}`);
        if (expanded) {
            for (const f of run.failures.slice(0, 12)) {
                lines.push(`    ${theme.fg("dim", f.scope)}: ${theme.fg("error", f.message)}`);
            }
            if (run.failures.length > 12) {
                lines.push(`    ${theme.fg("dim", `… ${run.failures.length - 12} more`)}`);
            }
        }
    }

    // Phase breakdown — our style: compact blocks per phase
    if (run.phases.length > 0) {
        lines.push("");
        for (const phase of run.phases) {
            const pDone = phase.agents.filter((id: string) => {
                const a = run.agents[id];
                return a?.status === "completed" || a?.status === "cached";
            }).length;
            const pTotal = phase.agents.length;
            const pCost = phase.usage.cost ? ` · $${phase.usage.cost.toFixed(4)}` : "";
            const phaseBar = pTotal > 0 ? ` ${theme.fg("dim", bar(pDone, pTotal, 10))}` : "";
            lines.push(`  ${colorSigil(phase.status, theme)} ${theme.bold(phase.title)} ${theme.fg("dim", `${pDone}/${pTotal}${pCost}`)}${phaseBar}`);

            if (expanded && pTotal > 0) {
                for (const agentId of phase.agents) {
                    const agent = run.agents[agentId];
                    if (!agent) continue;
                    const dur = agent.durationMs ? ` ${theme.fg("dim", `${(agent.durationMs / 1000).toFixed(1)}s`)}` : "";
                    const err = agent.error ? ` ${theme.fg("error", `⚠ ${agent.error}`)}` : "";
                    lines.push(`    ${colorSigil(agent.status, theme)} ${agent.label}${dur}${err}`);
                    lines.push(`    ${theme.fg("muted", `  ${agent.promptPreview}`)}`);
                }
            }
        }
    }

    // Recent logs — always show last few, expand for more
    if (run.logs.length > 0) {
        lines.push("");
        const logs = expanded ? run.logs : run.logs.slice(-5);
        for (const log of logs) {
            const time = new Date(log.at).toLocaleTimeString();
            const phase = log.phase ? theme.fg("dim", `[${log.phase}]`) + " " : "";
            lines.push(`  ${theme.fg("dim", time)} ${phase}${log.message}`);
        }
        if (!expanded && run.logs.length > 5) {
            lines.push(`  ${theme.fg("dim", `… ${run.logs.length - 5} earlier entries`)}`);
        }
    }

    // Result — only in expanded view
    if (expanded && run.result !== undefined) {
        lines.push("");
        lines.push(theme.fg("accent", "── result ──"));
        const rendered = typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2);
        for (const line of rendered.split("\n").slice(0, 80)) lines.push(`  ${line}`);
    }

    return lines.join("\n");
}

export function renderWorkflowResult(
    result: { content?: Array<{ type: string; text?: string }>; details?: SpindleWorkflowDetails },
    expanded: boolean,
    theme: Theme,
): Text {
    const details = result.details;
    if (!details) {
        const text = result.content?.[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    }

    if (details.kind === "workflow" && details.run) {
        return new Text(formatWorkflowRun(details.run, theme, expanded), 0, 0);
    }

    if (details.kind === "workflow-list") {
        const runs = details.runs ?? [];
        const library = details.library ?? [];
        const lines: string[] = [];

        if (library.length > 0) {
            lines.push(theme.fg("accent", `── ${library.length} saved workflow${library.length === 1 ? "" : "s"} ──`));
            for (const entry of library) {
                lines.push(`  ${theme.fg("toolTitle", entry.name)} ${theme.fg("dim", `[${entry.scope}]`)}`);
                lines.push(`    ${theme.fg("muted", entry.description)}`);
                if (entry.whenToUse) lines.push(`    ${theme.fg("dim", `use when: ${entry.whenToUse}`)}`);
            }
        }

        if (runs.length > 0) {
            lines.push("");
            lines.push(theme.fg("accent", `── ${runs.length} recent run${runs.length === 1 ? "" : "s"} ──`));
            for (const r of runs) {
                const done = r.agentOrder.filter((id) => {
                    const s = r.agents[id]?.status;
                    return s === "completed" || s === "cached";
                }).length;
                const total = r.agentOrder.length;
                lines.push(`  ${colorSigil(r.status, theme)} ${theme.fg("toolTitle", r.name)} ${theme.fg("dim", `${done}/${total} · ${summarizeWorkflowRun(r)}`)}`);
            }
        }

        if (library.length === 0 && runs.length === 0) {
            lines.push(theme.fg("muted", "No workflows yet. Create one: /spindle save <name>"));
        }

        return new Text(lines.join("\n"), 0, 0);
    }

    const text = result.content?.[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}

export function formatWorkflowList(runs: WorkflowRun[], theme: Theme): string {
    if (runs.length === 0) return theme.fg("muted", "No workflows have run yet.");
    return runs.map((run) => {
        const done = run.agentOrder.filter((id) => {
            const s = run.agents[id]?.status;
            return s === "completed" || s === "cached";
        }).length;
        const total = run.agentOrder.length;
        return `${colorSigil(run.status, theme)} ${theme.fg("toolTitle", run.name)} ${theme.fg("dim", `${done}/${total} · ${summarizeWorkflowRun(run)}`)}`;
    }).join("\n");
}