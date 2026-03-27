/**
 * Dashboard — styled status widget showing active subagents.
 *
 * Returns a component factory for ctx.ui.setWidget().
 */

import { readStatusFile, type SubagentHandle } from "./workers.js";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}m${secs.toString().padStart(2, "0")}s`;
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + "…";
}

export function renderDashboard(
    subagents: Map<string, SubagentHandle>,
    theme: Theme,
): Text {
    if (subagents.size === 0) return new Text("", 0, 0);

    const running = [...subagents.values()].filter(h => !(h as any).resolved);
    const done = subagents.size - running.length;

    const lines: string[] = [];

    // Header
    const counts: string[] = [];
    if (running.length > 0) counts.push(theme.fg("warning", `${running.length} running`));
    if (done > 0) counts.push(theme.fg("success", `${done} done`));
    lines.push(
        theme.fg("muted", "──") + " " +
        theme.fg("toolTitle", theme.bold("Subagents")) + " " +
        theme.fg("muted", "(") + counts.join(theme.fg("muted", ", ")) + theme.fg("muted", ")") + " " +
        theme.fg("muted", "──"),
    );

    for (const [, handle] of subagents) {
        const statusDir = (handle as any).statusDir as string;
        const sf = readStatusFile(statusDir);
        const resolved = (handle as any).resolved;
        const elapsed = Date.now() - handle.startTime;

        let icon: string;
        let statusText: string;
        let durationColor: string;

        if (resolved) {
            const s = sf?.status || "crashed";
            if (s === "done" && sf?.exitCode === 0) {
                icon = theme.fg("success", "✓");
                statusText = handle.branch
                    ? theme.fg("dim", "done · ") + theme.fg("accent", handle.branch)
                    : theme.fg("dim", "done");
            } else {
                icon = theme.fg("error", "✗");
                statusText = s === "crashed"
                    ? theme.fg("error", "crashed")
                    : theme.fg("error", "failed");
            }
            durationColor = "dim";
        } else if (sf?.currentTool) {
            icon = theme.fg("warning", "⏳");
            const tool = sf.currentArgs
                ? `${sf.currentTool} ${theme.fg("dim", truncate(sf.currentArgs, 30))}`
                : sf.currentTool;
            statusText = theme.fg("muted", tool);
            durationColor = "muted";
        } else {
            icon = theme.fg("warning", "⏳");
            statusText = theme.fg("dim", "starting…");
            durationColor = "muted";
        }

        const duration = formatDuration(sf?.endTime ? sf.endTime - sf.startTime : elapsed);
        const taskPreview = truncate(handle.task, 28);

        lines.push(
            `  ${icon} ` +
            theme.fg("accent", handle.id) + " " +
            theme.fg("muted", taskPreview) +
            "  " + theme.fg(durationColor as any, duration) +
            "  " + statusText,
        );
    }

    return new Text(lines.join("\n"), 0, 0);
}
