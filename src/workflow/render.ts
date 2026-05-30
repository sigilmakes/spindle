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

function icon(status: string): string {
    switch (status) {
        case "done": case "completed": case "cached": return "✓";
        case "failed": case "cancelled": return "✗";
        case "running": case "starting": return "●";
        case "queued": case "waiting": return "○";
        default: return "·";
    }
}

function colorStatus(status: string, theme: Theme, text: string): string {
    switch (status) {
        case "done": case "completed": case "cached": return theme.fg("success", text);
        case "failed": case "cancelled": return theme.fg("error", text);
        case "running": case "starting": return theme.fg("warning", text);
        default: return theme.fg("muted", text);
    }
}

export function formatWorkflowRun(run: WorkflowRun, theme: Theme, expanded: boolean = false): string {
    const lines: string[] = [];
    lines.push(`${colorStatus(run.status, theme, icon(run.status))} ${theme.fg("toolTitle", theme.bold(run.name))} ${theme.fg("dim", run.id)}`);
    lines.push(`  ${theme.fg("muted", run.description)}`);
    lines.push(`  ${theme.fg("accent", summarizeWorkflowRun(run))}`);

    if (run.error) {
        lines.push(`  ${theme.fg("error", `${run.error.name}: ${run.error.message}`)}`);
    }

    if (run.failures.length > 0) {
        lines.push(`  ${theme.fg("error", `Failures: ${run.failures.length}`)}`);
        if (expanded) {
            for (const f of run.failures.slice(0, 20)) {
                lines.push(`    ${theme.fg("dim", f.scope)}: ${theme.fg("error", f.message)}`);
            }
        }
    }

    if (run.phases.length > 0) {
        lines.push("");
        lines.push(theme.fg("accent", "Phases"));
        for (const phase of run.phases) {
            const done = phase.agents.filter((id: string) => {
                const a = run.agents[id];
                return a?.status === "completed" || a?.status === "cached";
            }).length;
            const total = phase.agents.length;
            const usage = phase.usage.cost ? ` $${phase.usage.cost.toFixed(4)}` : "";
            lines.push(`  ${colorStatus(phase.status, theme, icon(phase.status))} ${phase.title} ${theme.fg("dim", `${done}/${total}${usage}`)}`);
            if (expanded) {
                for (const agentId of phase.agents) {
                    const agent = run.agents[agentId];
                    if (!agent) continue;
                    const dur = agent.durationMs ? ` ${(agent.durationMs / 1000).toFixed(1)}s` : "";
                    const suffix = agent.error ? ` — ${agent.error}` : dur;
                    lines.push(`      ${colorStatus(agent.status, theme, icon(agent.status))} ${agent.label} ${theme.fg("dim", suffix)}`);
                    lines.push(`        ${theme.fg("muted", agent.promptPreview)}`);
                }
            }
        }
    }

    if (run.logs.length > 0) {
        lines.push("");
        lines.push(theme.fg("accent", "Logs"));
        const logs = expanded ? run.logs : run.logs.slice(-8);
        for (const log of logs) {
            const time = new Date(log.at).toLocaleTimeString();
            const phase = log.phase ? theme.fg("dim", `[${log.phase}] `) : "";
            lines.push(`  ${theme.fg("dim", time)} ${phase}${log.message}`);
        }
    }

    if (expanded && run.result !== undefined) {
        lines.push("");
        lines.push(theme.fg("accent", "Result"));
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
        const lines = [
            library.length === 0 ? theme.fg("muted", "No saved workflows.") : theme.fg("accent", `Saved workflows (${library.length})`),
            ...library.flatMap((entry) => [`  ${theme.fg("toolTitle", entry.name)} ${theme.fg("dim", `[${entry.scope}]`)}`, `    ${theme.fg("muted", entry.description)}`]),
            "",
            theme.fg("accent", "Recent runs"),
            runs.length === 0 ? theme.fg("muted", "No runs yet.") : runs.map((r: WorkflowRun) => {
                const head = `${colorStatus(r.status, theme, icon(r.status))} ${theme.fg("toolTitle", r.name)} ${theme.fg("dim", r.id)}`;
                return `${head}\n  ${theme.fg("muted", summarizeWorkflowRun(r))}`;
            }).join("\n"),
        ];
        return new Text(lines.join("\n"), 0, 0);
    }

    const text = result.content?.[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}

export function formatWorkflowList(runs: WorkflowRun[], theme: Theme): string {
    if (runs.length === 0) return theme.fg("muted", "No workflows have run yet.");
    return runs.map((run) => {
        const head = `${colorStatus(run.status, theme, icon(run.status))} ${theme.fg("toolTitle", run.name)} ${theme.fg("dim", run.id)}`;
        return `${head}\n  ${theme.fg("muted", summarizeWorkflowRun(run))}`;
    }).join("\n\n");
}