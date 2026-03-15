import * as fs from "node:fs";
import * as path from "node:path";
import {
    createReadTool, createBashTool, createEditTool, createWriteTool,
    createGrepTool, createFindTool, createLsTool,
} from "@mariozechner/pi-coding-agent";
import type { EditOperations } from "@mariozechner/pi-coding-agent";
import { withFileLock, DEFAULT_LOCK_TIMEOUT } from "./locks.js";
const DEFAULT_MAX_LOAD_SIZE = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// FileConflictError — thrown when a file's mtime doesn't match expectations
// ---------------------------------------------------------------------------

export class FileConflictError extends Error {
    readonly path: string;
    readonly expectedMtime: number;
    readonly actualMtime: number;

    constructor(filePath: string, expectedMtime: number, actualMtime: number) {
        super(
            `File modified since read: ${filePath} (expected mtime ${expectedMtime}, actual ${actualMtime}). ` +
            `Another process may have edited this file concurrently.`,
        );
        this.name = "FileConflictError";
        this.path = filePath;
        this.expectedMtime = expectedMtime;
        this.actualMtime = actualMtime;
    }
}

// ---------------------------------------------------------------------------
// guardedWrite — write with optional mtime pre-check
// ---------------------------------------------------------------------------

export function guardedWrite(
    filePath: string,
    content: string,
    expectedMtimeMs?: number,
): void {
    if (expectedMtimeMs !== undefined) {
        try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs !== expectedMtimeMs) {
                throw new FileConflictError(filePath, expectedMtimeMs, stat.mtimeMs);
            }
        } catch (err) {
            if (err instanceof FileConflictError) throw err;
            // File doesn't exist yet — that's fine, skip the guard
        }
    }
    fs.writeFileSync(filePath, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Mtime-tracking EditOperations wrapper
// ---------------------------------------------------------------------------

/** Module-scoped mtime map shared across all guarded edit tool instances */
const mtimeMap = new Map<string, number>();

/** Expose the mtime map for testing */
export function getMtimeMap(): Map<string, number> {
    return mtimeMap;
}

export function createMtimeGuardedEditOperations(): EditOperations {
    return {
        readFile: async (absolutePath: string): Promise<Buffer> => {
            const buffer = await fs.promises.readFile(absolutePath);
            const stat = await fs.promises.stat(absolutePath);
            mtimeMap.set(absolutePath, stat.mtimeMs);
            return buffer;
        },

        writeFile: async (absolutePath: string, content: string): Promise<void> => {
            const expectedMtime = mtimeMap.get(absolutePath);
            if (expectedMtime !== undefined) {
                try {
                    const stat = await fs.promises.stat(absolutePath);
                    if (stat.mtimeMs !== expectedMtime) {
                        throw new FileConflictError(absolutePath, expectedMtime, stat.mtimeMs);
                    }
                } catch (err) {
                    if (err instanceof FileConflictError) throw err;
                    // File doesn't exist — no conflict possible
                }
            }
            await fs.promises.writeFile(absolutePath, content, "utf-8");
            // Update stashed mtime after successful write
            try {
                const newStat = await fs.promises.stat(absolutePath);
                mtimeMap.set(absolutePath, newStat.mtimeMs);
            } catch {
                mtimeMap.delete(absolutePath);
            }
        },

        access: async (absolutePath: string): Promise<void> => {
            await fs.promises.access(absolutePath, fs.constants.R_OK | fs.constants.W_OK);
        },
    };
}

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
    const tools: Record<string, any> = {
        read: createReadTool(cwd),
        bash: createBashTool(cwd),
        edit: createEditTool(cwd, { operations: createMtimeGuardedEditOperations() }),
        write: createWriteTool(cwd),
        grep: createGrepTool(cwd),
        find: createFindTool(cwd),
        ls: createLsTool(cwd),
    };

    const wrappers: ToolWrappers = {};
    for (const [name, tool] of Object.entries(tools)) {
        if (name === "edit" || name === "write") {
            // Wrap file-mutating tools with file locks
            wrappers[name] = async (args: Record<string, unknown>) => {
                const filePath = args.path as string | undefined;
                if (filePath) {
                    const resolved = path.resolve(cwd, filePath);
                    return withFileLock(resolved, async () => {
                        const result = await tool.execute(`spindle-${name}-${Date.now()}`, args);
                        return extractText(result);
                    }, { timeout: DEFAULT_LOCK_TIMEOUT });
                }
                // No path (shouldn't happen for edit/write, but be safe)
                const result = await tool.execute(`spindle-${name}-${Date.now()}`, args);
                return extractText(result);
            };
        } else {
            wrappers[name] = async (args: Record<string, unknown>) => {
                const result = await tool.execute(`spindle-${name}-${Date.now()}`, args);
                return extractText(result);
            };
        }
    }
    return wrappers;
}

export interface LoadResult {
    content: string | Map<string, string>;
    metadata: { type: "file" | "directory"; totalSize: number; fileCount: number; mtimeMs?: number };
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
            metadata: { type: "file", totalSize: stat.size, fileCount: 1, mtimeMs: stat.mtimeMs },
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
                    } catch { /* skip unreadable */ }
                }
            }
        }

        walk(resolved, "");
        return { content: files, metadata: { type: "directory", totalSize, fileCount: files.size } };
    }

    throw new Error(`Not a file or directory: ${resolved}`);
}

export async function save(targetPath: string, content: string, cwd: string, expectedMtimeMs?: number): Promise<void> {
    const resolved = path.resolve(cwd, targetPath);
    // Ensure parent dirs exist before acquiring lock (lock dir is a sibling of the file)
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    await withFileLock(resolved, () => {
        guardedWrite(resolved, content, expectedMtimeMs);
    }, { timeout: DEFAULT_LOCK_TIMEOUT });
}

export function createFileIO(cwd: string) {
    return {
        load: async (targetPath: string) => (await load(targetPath, cwd)).content,
        save: async (targetPath: string, content: string) => { await save(targetPath, content, cwd); },
    };
}
