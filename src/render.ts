import * as os from "node:os";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { highlightCode, type Theme } from "@mariozechner/pi-coding-agent";
import { type DisplayItem, type Episode, type ThreadState, COLLAPSED_ITEM_COUNT } from "./threads.js";

export interface SpindleExecDetails {
    code: string;
    file?: string;
    episodes?: Episode[];
    threadStates?: ThreadState[];
    durationMs?: number;
    error?: boolean;
}

export interface SpindleStatusDetails {
    variables: Array<{ name: string; type: string; preview: string }>;
    usage: { totalCost: number; totalEpisodes: number; totalLlmCalls: number };
    config: { subModel: string | undefined; outputLimit: number };
}

export function formatCodeForDisplay(code: string, theme: Theme): string {
    let highlighted: string[];
    try {
        highlighted = highlightCode(code, "javascript");
    } catch {
        highlighted = code.split("\n");
    }

    let text = theme.fg("toolTitle", theme.bold("spindle_exec")) + "\n";
    for (const line of highlighted) {
        text += "  " + line + "\n";
    }
    return text.trimEnd();
}

export function formatFileExecForDisplay(file: string, theme: Theme): string {
    return theme.fg("toolTitle", theme.bold("spindle_exec")) + " " + theme.fg("accent", file);
}

// --- Tool call formatting (adapted from subagent extension) ---

function shortenPath(p: string): string {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(name: string, args: Record<string, unknown>, theme: Theme): string {
    switch (name) {
        case "bash": {
            const cmd = (args.command as string) || "...";
            const preview = cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd;
            return theme.fg("muted", "$ ") + theme.fg("toolOutput", preview);
        }
        case "read": {
            const p = shortenPath((args.file_path || args.path || "...") as string);
            let text = theme.fg("muted", "read ") + theme.fg("accent", p);
            const offset = args.offset as number | undefined;
            const limit = args.limit as number | undefined;
            if (offset || limit) text += theme.fg("dim", `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : ""}`);
            return text;
        }
        case "write": {
            const p = shortenPath((args.file_path || args.path || "...") as string);
            return theme.fg("muted", "write ") + theme.fg("accent", p);
        }
        case "edit": {
            const p = shortenPath((args.file_path || args.path || "...") as string);
            return theme.fg("muted", "edit ") + theme.fg("accent", p);
        }
        case "grep": {
            const pattern = (args.pattern || "") as string;
            const p = shortenPath((args.path || ".") as string);
            return theme.fg("muted", "grep ") + theme.fg("accent", `/${pattern}/`) + theme.fg("dim", ` in ${p}`);
        }
        case "find": {
            const pattern = (args.pattern || "*") as string;
            const p = shortenPath((args.path || ".") as string);
            return theme.fg("muted", "find ") + theme.fg("accent", pattern) + theme.fg("dim", ` in ${p}`);
        }
        case "ls": {
            const p = shortenPath((args.path || ".") as string);
            return theme.fg("muted", "ls ") + theme.fg("accent", p);
        }
        default: {
            const s = JSON.stringify(args);
            const preview = s.length > 40 ? s.slice(0, 40) + "..." : s;
            return theme.fg("accent", name) + theme.fg("dim", ` ${preview}`);
        }
    }
}

function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
    return `${Math.round(n / 1000)}k`;
}

// --- Thread column rendering ---

function formatThreadColumn(state: ThreadState, expanded: boolean, theme: Theme): string {
    const icon = state.status === "done"
        ? (state.episode?.status === "success" ? theme.fg("success", "✓")
            : state.episode?.status === "failure" ? theme.fg("error", "✗")
            : state.episode?.status === "blocked" ? theme.fg("warning", "⚠")
            : theme.fg("success", "✓"))
        : state.status === "running" ? theme.fg("warning", "○")
        : theme.fg("dim", "○");

    const taskPreview = state.task.length > 40 ? state.task.slice(0, 40) + "..." : state.task;
    let col = `${icon} ${theme.fg("accent", state.agent)}: ${theme.fg("dim", taskPreview)}`;

    const items = state.displayItems;
    const showCount = expanded ? items.length : COLLAPSED_ITEM_COUNT;
    const skipped = Math.max(0, items.length - showCount);
    const visible = items.slice(-showCount);

    if (skipped > 0) {
        col += "\n  " + theme.fg("muted", `... +${skipped} earlier tools`);
    }

    for (const item of visible) {
        if (item.type === "toolCall") {
            const check = item.done ? theme.fg("success", " ✓") : "";
            const prefix = item.done ? theme.fg("muted", "→ ") : theme.fg("dim", "→ ");
            col += "\n  " + prefix + formatToolCall(item.name, item.args, theme) + check;
        } else if (item.type === "comm") {
            if (item.direction === "sent") {
                const target = item.peer === -1 ? "all" : `rank ${item.peer}`;
                col += "\n  " + theme.fg("muted", "→ ") + theme.fg("accent", target) + theme.fg("dim", `: ${item.msg}`);
            } else {
                col += "\n  " + theme.fg("muted", "← ") + theme.fg("accent", `rank ${item.peer}`) + theme.fg("dim", `: ${item.msg}`);
            }
        } else if (item.type === "warning") {
            col += "\n  " + theme.fg("warning", item.text);
        } else {
            col += "\n  " + theme.fg("dim", item.text);
        }
    }

    // Stats line
    const elapsed = state.status === "running"
        ? (Date.now() - state.startTime) / 1000
        : state.durationMs / 1000;
    const tokens = state.usage.input + state.usage.output;

    if (state.status === "done" && state.episode) {
        col += "\n  " + theme.fg("dim", `${elapsed.toFixed(0)}s · ${formatTokens(tokens)} · $${state.cost.toFixed(4)}`);
    } else if (state.status === "running") {
        const parts = [`${elapsed.toFixed(0)}s`];
        if (tokens > 0) parts.push(formatTokens(tokens));
        if (state.cost > 0) parts.push(`$${state.cost.toFixed(4)}`);
        col += "\n  " + theme.fg("dim", `Working... ${parts.join(" · ")}`);
    }

    return col;
}

// --- Public render functions ---

export function formatDispatchUpdate(threads: ThreadState[]): string {
    const running = threads.filter(t => t.status === "running").length;
    const done = threads.filter(t => t.status === "done").length;
    const pending = threads.filter(t => t.status === "pending").length;

    let text = `Dispatching ${threads.length} threads: ${done} done, ${running} running`;
    if (pending > 0) text += `, ${pending} pending`;

    const elapsed = Math.max(0, ...threads
        .filter(t => t.startTime > 0)
        .map(t => t.status === "done" ? t.durationMs : Date.now() - t.startTime));
    text += ` (${(elapsed / 1000).toFixed(0)}s)`;

    // Collect warnings across all threads
    const warnings: string[] = [];
    for (const t of threads) {
        for (const item of t.displayItems) {
            if (item.type === "warning" && !warnings.includes(item.text)) {
                warnings.push(item.text);
            }
        }
    }

    for (const t of threads) {
        const icon = t.status === "done" ? "✓" : t.status === "running" ? "○" : "·";
        text += `\n  ${icon} ${t.agent}: `;
        if (t.status === "done" && t.episode) {
            text += `${t.episode.status} — ${t.episode.summary.slice(0, 60)}`;
        } else if (t.status === "running") {
            text += `${t.toolCount} tools, ${((Date.now() - t.startTime) / 1000).toFixed(0)}s`;
        } else {
            text += "pending";
        }
    }

    if (warnings.length > 0) {
        text += "\n";
        for (const w of warnings) {
            text += `\n  ${w}`;
        }
    }

    return text;
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

    // Console output (non-dispatch)
    if (textContent && !details?.threadStates?.length) {
        const lines = textContent.split("\n");
        const max = expanded ? lines.length : 20;
        text += lines.slice(0, max).map(l => theme.fg("toolOutput", l)).join("\n");
        if (lines.length > max) {
            text += "\n" + theme.fg("muted", `... ${lines.length - max} more lines (Ctrl+O to expand)`);
        }
    }

    // Dispatch thread columns
    if (details?.threadStates?.length) {
        const states = details.threadStates;
        const done = states.filter(t => t.status === "done").length;
        text += theme.fg("muted", `─── Dispatch: ${done}/${states.length} complete ───`);

        for (const state of states) {
            text += "\n\n" + formatThreadColumn(state, expanded, theme);
        }

        const totalCost = states.reduce((s, t) => s + t.cost, 0);
        const wallTime = Math.max(0, ...states.map(t => t.durationMs));
        text += "\n\n" + theme.fg("dim",
            `Total: ${states.length} threads · ${(wallTime / 1000).toFixed(1)}s wall · $${totalCost.toFixed(4)}`);

        if (!expanded) {
            text += "\n" + theme.fg("muted", "(Ctrl+O to expand)");
        }
    }
    // Fallback: episodes without threadStates (e.g. from text content)
    else if (details?.episodes?.length) {
        const eps = details.episodes;
        text += "\n" + theme.fg("muted", `─── Episodes: ${eps.length} ───`);
        for (const ep of eps) {
            const icon = ep.status === "success" ? theme.fg("success", "✓")
                : ep.status === "failure" ? theme.fg("error", "✗") : theme.fg("warning", "⚠");
            text += `\n${icon} ${theme.fg("accent", ep.agent)}: ${ep.summary.slice(0, 80)}`;
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

    return text;
}
