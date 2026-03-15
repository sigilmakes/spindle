import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { highlightCode, type Theme } from "@mariozechner/pi-coding-agent";
import type { Episode, ThreadState } from "./threads.js";

export interface SpindleExecDetails {
    code: string;
    episodes?: Episode[];
    durationMs?: number;
    error?: boolean;
}

export interface SpindleStatusDetails {
    variables: Array<{ name: string; type: string; preview: string }>;
    usage: { totalCost: number; totalEpisodes: number; totalLlmCalls: number };
    config: { subModel: string | undefined; outputLimit: number; timeoutMs: number };
}

export function formatCodeForDisplay(code: string, theme: Theme, maxLines = 15): string {
    let highlighted: string[];
    try {
        highlighted = highlightCode(code, "javascript");
    } catch {
        highlighted = code.split("\n");
    }

    let text = theme.fg("toolTitle", theme.bold("spindle_exec")) + "\n";
    for (const line of highlighted.slice(0, maxLines)) {
        text += "  " + line + "\n";
    }
    if (highlighted.length > maxLines) {
        text += theme.fg("muted", `  ... ${highlighted.length - maxLines} more lines`);
    }
    return text.trimEnd();
}

function episodeIcon(ep: Episode, theme: Theme): string {
    switch (ep.status) {
        case "success": return theme.fg("success", "✓");
        case "failure": return theme.fg("error", "✗");
        case "blocked": return theme.fg("warning", "⚠");
        default: return theme.fg("dim", "○");
    }
}

function formatEpisodeColumn(ep: Episode, expanded: boolean, theme: Theme): string {
    const icon = episodeIcon(ep, theme);
    const taskPreview = ep.task.length > 40 ? ep.task.slice(0, 40) + "..." : ep.task;
    let col = `${icon} ${theme.fg("accent", ep.agent)}: ${theme.fg("dim", taskPreview)}`;
    col += `\n  ${ep.summary.slice(0, 80)}${ep.summary.length > 80 ? "..." : ""}`;

    if (expanded && ep.findings.length > 0) {
        for (const f of ep.findings) col += "\n  " + theme.fg("dim", "- " + f);
    }
    if (expanded && ep.artifacts.length > 0) {
        col += "\n  " + theme.fg("dim", "Artifacts: " + ep.artifacts.join(", "));
    }
    if (ep.blockers.length > 0) {
        col += "\n  " + theme.fg("warning", "Blocked: " + ep.blockers.join(", "));
    }

    col += "\n  " + theme.fg("dim", `${ep.toolCalls} tools · ${(ep.duration / 1000).toFixed(1)}s · $${ep.cost.toFixed(4)}`);
    return col;
}

export function formatExecResult(
    result: AgentToolResult<SpindleExecDetails>,
    expanded: boolean,
    theme: Theme,
): string {
    const details = result.details;
    const textContent = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text).join("\n");

    let text = details?.error ? theme.fg("error", "✗ Error\n") : theme.fg("success", "✓") + " ";
    if (details?.durationMs) text += theme.fg("dim", `${(details.durationMs / 1000).toFixed(1)}s`);
    text += "\n";

    if (textContent) {
        const lines = textContent.split("\n");
        const max = expanded ? lines.length : 20;
        text += lines.slice(0, max).map(l => theme.fg("toolOutput", l)).join("\n");
        if (lines.length > max) {
            text += "\n" + theme.fg("muted", `... ${lines.length - max} more lines (Ctrl+O to expand)`);
        }
    }

    if (details?.episodes?.length) {
        const eps = details.episodes;
        const done = eps.filter(e => e.status !== "running").length;
        text += "\n\n" + theme.fg("muted", `─── Dispatch: ${done}/${eps.length} complete ───`);

        for (const ep of eps) {
            text += "\n\n" + formatEpisodeColumn(ep, expanded, theme);
        }

        const totalCost = eps.reduce((s, e) => s + e.cost, 0);
        const totalDuration = Math.max(...eps.map(e => e.duration));
        text += "\n\n" + theme.fg("dim",
            `Total: ${eps.length} threads · ${(totalDuration / 1000).toFixed(1)}s wall · $${totalCost.toFixed(4)}`);

        if (!expanded && eps.some(e => e.findings.length > 0)) {
            text += "\n" + theme.fg("muted", "(Ctrl+O for findings/artifacts)");
        }
    }

    return text;
}

export function formatStatusResult(details: SpindleStatusDetails, theme: Theme): string {
    let text = theme.fg("toolTitle", theme.bold("Spindle Status")) + "\n";

    if (details.variables.length > 0) {
        text += "\n" + theme.fg("muted", "─── Variables ───") + "\n";
        for (const v of details.variables) {
            text += `  ${theme.fg("accent", v.name)}: ${theme.fg("dim", v.type)} = ${theme.fg("toolOutput", v.preview)}\n`;
        }
    } else {
        text += "\n" + theme.fg("muted", "No variables") + "\n";
    }

    text += "\n" + theme.fg("muted", "─── Usage ───") + "\n";
    text += `  Episodes: ${details.usage.totalEpisodes}\n`;
    text += `  LLM calls: ${details.usage.totalLlmCalls}\n`;
    text += `  Cost: $${details.usage.totalCost.toFixed(4)}\n`;

    text += "\n" + theme.fg("muted", "─── Config ───") + "\n";
    text += `  Sub-model: ${details.config.subModel || "(default)"}\n`;
    text += `  Output limit: ${details.config.outputLimit} chars\n`;
    text += `  Timeout: ${details.config.timeoutMs / 1000}s\n`;

    return text;
}

export function formatDispatchProgress(threads: ThreadState[]): string {
    const running = threads.filter(t => t.status === "running");
    const done = threads.filter(t => t.status === "done");
    const pending = threads.filter(t => t.status === "pending");

    const elapsed = Math.max(0, ...threads
        .filter(t => t.startTime > 0)
        .map(t => t.status === "done" ? t.durationMs : Date.now() - t.startTime));

    let text = `Dispatching ${threads.length} threads: ${done.length} done, ${running.length} running`;
    if (pending.length > 0) text += `, ${pending.length} pending`;
    text += ` (${(elapsed / 1000).toFixed(0)}s)`;

    for (const t of threads) {
        const icon = t.status === "done" ? "✓"
            : t.status === "running" ? "⏳"
            : "○";
        const taskPreview = t.task.length > 50 ? t.task.slice(0, 50) + "..." : t.task;
        text += `\n  ${icon} ${t.agent}: ${taskPreview}`;

        if (t.status === "running") {
            const sec = ((Date.now() - t.startTime) / 1000).toFixed(0);
            text += ` (${sec}s)`;
            if (t.recentTools.length > 0) {
                text += ` — ${t.recentTools.slice(-3).join(", ")}`;
            }
        } else if (t.status === "done" && t.episode) {
            const ep = t.episode;
            text += ` — ${ep.status}`;
            if (ep.summary) text += `: ${ep.summary.slice(0, 60)}`;
        }
    }

    return text;
}
