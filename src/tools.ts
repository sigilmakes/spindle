import * as fs from "node:fs";
import * as path from "node:path";
import { createAllTools } from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const DEFAULT_MAX_LOAD_SIZE = 10 * 1024 * 1024;

const SKIP_DIRS = new Set([
    "node_modules", ".git", "dist", "build", "coverage",
    ".next", ".nuxt", "__pycache__", ".venv", "venv", ".tox",
]);

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
}

export type ToolWrappers = Record<string, (args: Record<string, unknown>) => Promise<string>>;

export function createToolWrappers(cwd: string): ToolWrappers {
    const tools = createAllTools(cwd);
    const wrappers: ToolWrappers = {};

    for (const [name, tool] of Object.entries(tools)) {
        const t = tool as AgentTool;
        wrappers[name] = async (args: Record<string, unknown>) => {
            const result = await t.execute(`spindle-${name}-${Date.now()}`, args);
            return extractText(result);
        };
    }

    return wrappers;
}

export interface LoadResult {
    content: string | Map<string, string>;
    metadata: { type: "file" | "directory"; totalSize: number; fileCount: number };
}

export async function load(
    targetPath: string,
    cwd: string,
    maxSize: number = DEFAULT_MAX_LOAD_SIZE,
): Promise<LoadResult> {
    const resolved = path.resolve(cwd, targetPath);
    const stat = fs.statSync(resolved);

    if (stat.isFile()) {
        if (stat.size > maxSize) {
            throw new Error(
                `File too large: ${stat.size} bytes (max ${maxSize}). Use read() with offset/limit for large files.`,
            );
        }
        return {
            content: fs.readFileSync(resolved, "utf-8"),
            metadata: { type: "file", totalSize: stat.size, fileCount: 1 },
        };
    }

    if (stat.isDirectory()) {
        const files = new Map<string, string>();
        let totalSize = 0;

        function walk(dir: string, prefix: string): void {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
                const fullPath = path.join(dir, entry.name);
                const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

                if (entry.isDirectory()) {
                    walk(fullPath, relPath);
                } else if (entry.isFile()) {
                    try {
                        const s = fs.statSync(fullPath);
                        if (totalSize + s.size > maxSize) return;
                        files.set(relPath, fs.readFileSync(fullPath, "utf-8"));
                        totalSize += s.size;
                    } catch { /* skip unreadable files */ }
                }
            }
        }

        walk(resolved, "");
        return { content: files, metadata: { type: "directory", totalSize, fileCount: files.size } };
    }

    throw new Error(`Not a file or directory: ${resolved}`);
}

export async function save(targetPath: string, content: string, cwd: string): Promise<void> {
    const resolved = path.resolve(cwd, targetPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
}

export function createFileIO(cwd: string) {
    return {
        load: async (targetPath: string) => (await load(targetPath, cwd)).content,
        save: async (targetPath: string, content: string) => { await save(targetPath, content, cwd); },
    };
}
