import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowMeta } from "./meta.js";
import type { WorkflowMeta } from "./types.js";

export interface WorkflowLibraryEntry {
    name: string;
    description: string;
    whenToUse?: string;
    path: string;
    scope: "project" | "global";
    meta: WorkflowMeta;
}

function workflowDirs(cwd: string): Array<{ dir: string; scope: "project" | "global" }> {
    return [
        { dir: path.join(cwd, ".pi", "threads"), scope: "project" as const },
        { dir: path.join(os.homedir(), ".pi", "agent", "threads"), scope: "global" as const },
    ];
}

function isWorkflowFile(file: string): boolean {
    return file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".ts");
}

export function discoverWorkflows(cwd: string): WorkflowLibraryEntry[] {
    const entries: WorkflowLibraryEntry[] = [];
    const seen = new Set<string>();
    for (const { dir, scope } of workflowDirs(cwd)) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            const filePath = path.join(dir, name);
            if (!fs.statSync(filePath).isFile() || !isWorkflowFile(name)) continue;
            try {
                const script = fs.readFileSync(filePath, "utf-8");
                const meta = parseWorkflowMeta(script);
                if (seen.has(meta.name)) continue;
                seen.add(meta.name);
                entries.push({ name: meta.name, description: meta.description, whenToUse: meta.whenToUse, path: filePath, scope, meta });
            } catch { /* skip malformed */ }
        }
    }
    return entries;
}

export async function resolveWorkflow(cwd: string, nameOrPath: string): Promise<{ script: string; scriptPath?: string }> {
    const direct = path.resolve(cwd, nameOrPath);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
        return { script: fs.readFileSync(direct, "utf-8"), scriptPath: direct };
    }
    const entries = discoverWorkflows(cwd);
    const entry = entries.find((e) => e.name === nameOrPath || path.basename(e.path, path.extname(e.path)) === nameOrPath);
    if (!entry) throw new Error(`Workflow not found: ${nameOrPath}`);
    return { script: fs.readFileSync(entry.path, "utf-8"), scriptPath: entry.path };
}

export function saveWorkflow(cwd: string, name: string, script: string, scope: "project" | "global" = "project"): string {
    const dir = scope === "project"
        ? path.join(cwd, ".pi", "threads")
        : path.join(os.homedir(), ".pi", "agent", "threads");
    fs.mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
    const filePath = path.join(dir, `${safe}.js`);
    fs.writeFileSync(filePath, script, "utf-8");
    return filePath;
}