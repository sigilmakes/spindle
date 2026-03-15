import * as path from "node:path";

/**
 * Tracks file writes across dispatch threads and detects collisions
 * (multiple threads writing the same file).
 */
export class FileCollisionTracker {
    /** Maps absolute file path → set of thread indices that wrote it. */
    private filesWritten = new Map<string, Set<number>>();

    /** Accumulated warnings for the dispatch. */
    readonly warnings: string[] = [];

    /**
     * Record a file write from a thread. Returns a warning string if this
     * creates a collision (another thread already wrote to this path),
     * or null if no collision.
     */
    recordWrite(threadIndex: number, filePath: string, cwd?: string): string | null {
        const resolved = cwd ? path.resolve(cwd, filePath) : path.resolve(filePath);

        let writers = this.filesWritten.get(resolved);
        if (!writers) {
            writers = new Set();
            this.filesWritten.set(resolved, writers);
        }

        // Already recorded this thread for this file — no new collision
        if (writers.has(threadIndex)) return null;

        writers.add(threadIndex);

        if (writers.size > 1) {
            const indices = [...writers].sort((a, b) => a - b);
            const shortPath = shortenForWarning(resolved);
            const warning = `File collision: ${shortPath} written by threads ${indices.join(", ")}`;
            this.warnings.push(warning);
            return warning;
        }

        return null;
    }

    /** Get the set of thread indices that wrote to a given path. */
    getWriters(filePath: string, cwd?: string): number[] {
        const resolved = cwd ? path.resolve(cwd, filePath) : path.resolve(filePath);
        const writers = this.filesWritten.get(resolved);
        return writers ? [...writers].sort((a, b) => a - b) : [];
    }
}

function shortenForWarning(p: string): string {
    // Show just the last 3 path segments to keep warnings concise
    const parts = p.split(path.sep);
    if (parts.length <= 3) return p;
    return "…/" + parts.slice(-3).join("/");
}

/**
 * Extract file paths from a tool's arguments.
 * Handles both single-file tools (edit, write) and multi-edit batches.
 */
export function extractWritePaths(toolName: string, args: Record<string, unknown>): string[] {
    if (toolName !== "edit" && toolName !== "write") return [];

    const paths: string[] = [];

    // Single path
    const singlePath = (args.file_path || args.path) as string | undefined;
    if (singlePath) paths.push(singlePath);

    // Multi-edit: array of {path, oldText, newText}
    if (toolName === "edit" && Array.isArray(args.multi)) {
        for (const item of args.multi) {
            if (item && typeof item === "object" && typeof item.path === "string") {
                paths.push(item.path);
            }
        }
    }

    return paths;
}
