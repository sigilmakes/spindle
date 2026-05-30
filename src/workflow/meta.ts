import type { WorkflowMeta } from "./types.js";

function findObjectLiteral(source: string, start: number): string {
    const firstBrace = source.indexOf("{", start);
    if (firstBrace < 0) throw new Error("Workflow meta must be an object literal");
    let depth = 0;
    let inString: string | null = null;
    let escaped = false;
    for (let i = firstBrace; i < source.length; i++) {
        const ch = source[i];
        if (inString) {
            if (escaped) { escaped = false; continue; }
            if (ch === "\\") { escaped = true; continue; }
            if (ch === inString) inString = null;
            continue;
        }
        if (ch === "\"" || ch === "'" || ch === "`") { inString = ch; continue; }
        if (ch === "{") depth++;
        if (ch === "}") { depth--; if (depth === 0) return source.slice(firstBrace, i + 1); }
    }
    throw new Error("Unclosed workflow meta object literal");
}

export function parseWorkflowMeta(script: string): WorkflowMeta {
    const trimmed = script.trimStart();
    const leading = script.length - trimmed.length;
    const match = trimmed.match(/^export\s+const\s+meta\s*=/);
    if (!match) throw new Error("Workflow scripts must begin with `export const meta = { ... }`");
    const literal = findObjectLiteral(script, leading + match[0].length);
    const meta = new Function(`return (${literal});`)() as WorkflowMeta;
    if (!meta || typeof meta !== "object") throw new Error("Workflow meta must evaluate to an object");
    if (!meta.name || typeof meta.name !== "string") throw new Error("Workflow meta.name is required");
    if (!meta.description || typeof meta.description !== "string") throw new Error("Workflow meta.description is required");
    if (meta.whenToUse !== undefined && typeof meta.whenToUse !== "string") throw new Error("Workflow meta.whenToUse must be a string");
    if (meta.phases !== undefined && !Array.isArray(meta.phases)) throw new Error("Workflow meta.phases must be an array");
    for (const phase of meta.phases ?? []) {
        if (!phase || typeof phase !== "object" || typeof phase.title !== "string") throw new Error("Every workflow phase must have a string title");
    }
    return meta;
}

export function transformWorkflowScript(script: string): string {
    return script.replace(/^\s*export\s+const\s+meta\s*=/, "const meta =");
}
