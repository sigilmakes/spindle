import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseThreadMeta } from "./runtime.js";
import type { ThreadMeta } from "./types.js";

export interface ThreadLibraryEntry {
    name: string;
    description: string;
    path: string;
    scope: "project" | "global";
    meta: ThreadMeta;
}

function threadDirs(cwd: string): Array<{ dir: string; scope: "project" | "global" }> {
    return [
        { dir: path.join(cwd, ".pi", "threads"), scope: "project" },
        { dir: path.join(os.homedir(), ".pi", "agent", "threads"), scope: "global" },
    ];
}

function isThreadFile(file: string): boolean {
    return file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".ts");
}

export function discoverThreads(cwd: string): ThreadLibraryEntry[] {
    const entries: ThreadLibraryEntry[] = [];
    const seen = new Set<string>();
    for (const { dir, scope } of threadDirs(cwd)) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            const filePath = path.join(dir, name);
            if (!fs.statSync(filePath).isFile() || !isThreadFile(filePath)) continue;
            try {
                const script = fs.readFileSync(filePath, "utf-8");
                const meta = parseThreadMeta(script);
                const key = meta.name;
                if (seen.has(key)) continue;
                seen.add(key);
                entries.push({ name: meta.name, description: meta.description, path: filePath, scope, meta });
            } catch {
                // Skip malformed library scripts; validation happens when run directly.
            }
        }
    }
    return entries;
}

export async function resolveThread(cwd: string, nameOrPath: string): Promise<{ script: string; scriptPath?: string }> {
    const direct = path.resolve(cwd, nameOrPath);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
        return { script: fs.readFileSync(direct, "utf-8"), scriptPath: direct };
    }

    const entries = discoverThreads(cwd);
    const entry = entries.find((e) => e.name === nameOrPath || path.basename(e.path, path.extname(e.path)) === nameOrPath);
    if (!entry) throw new Error(`Thread not found: ${nameOrPath}`);
    return { script: fs.readFileSync(entry.path, "utf-8"), scriptPath: entry.path };
}

export function saveThread(cwd: string, name: string, script: string, scope: "project" | "global" = "project"): string {
    const dir = scope === "project"
        ? path.join(cwd, ".pi", "threads")
        : path.join(os.homedir(), ".pi", "agent", "threads");
    fs.mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "thread";
    const filePath = path.join(dir, `${safe}.js`);
    fs.writeFileSync(filePath, script, "utf-8");
    return filePath;
}
