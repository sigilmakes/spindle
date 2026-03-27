import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { highlightCode, type Theme } from "@mariozechner/pi-coding-agent";

export interface SpindleExecDetails {
    code: string;
    file?: string;
    durationMs?: number;
    error?: boolean;
}

export interface SpindleStatusDetails {
    variables: Array<{ name: string; type: string; preview: string }>;
    usage: { totalCost: number; totalLlmCalls: number };
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

export function formatExecResult(
    result: AgentToolResult<SpindleExecDetails>,
    expanded: boolean,
    theme: Theme,
): string {
    const details = result.details;
    if (!details) {
        const text = result.content[0];
        return text?.type === "text" ? text.text : "(no output)";
    }

    const text = result.content[0];
    const output = text?.type === "text" ? text.text : "(no output)";

    if (details.error) {
        return theme.fg("error", output);
    }

    let rendered = output;
    if (details.durationMs !== undefined && details.durationMs > 1000) {
        rendered += "\n" + theme.fg("dim", `${(details.durationMs / 1000).toFixed(1)}s`);
    }
    return rendered;
}

export function formatStatusResult(details: SpindleStatusDetails, theme: Theme): string {
    const parts: string[] = [];

    parts.push(theme.fg("toolTitle", theme.bold("Spindle Status")));
    parts.push("");

    // Variables
    parts.push(theme.fg("accent", "Variables:"));
    if (details.variables.length === 0) {
        parts.push("  " + theme.fg("muted", "(none)"));
    } else {
        for (const v of details.variables) {
            parts.push(`  ${theme.fg("accent", v.name)}: ${theme.fg("muted", v.type)} = ${theme.fg("dim", v.preview)}`);
        }
    }
    parts.push("");

    // Usage
    parts.push(theme.fg("accent", "Usage:"));
    parts.push(`  ${details.usage.totalLlmCalls} sub-agent calls, $${details.usage.totalCost.toFixed(4)}`);

    // Config
    parts.push("");
    parts.push(theme.fg("accent", "Config:"));
    parts.push(`  sub-model: ${details.config.subModel || "(default)"}`);

    return parts.join("\n");
}
