import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
    createReadTool, createEditTool, createWriteTool,
    createGrepTool, createFindTool, createLsTool,
} from "@mariozechner/pi-coding-agent";

const DEFAULT_MAX_LOAD_SIZE = 10 * 1024 * 1024;

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
}

/**
 * Unified result from all REPL tool builtins.
 * Never throws — errors are returned in .error with .ok = false.
 * Coerces to string via toString() for casual use.
 */
export class ToolResult {
    readonly output: string;
    readonly error: string;
    readonly ok: boolean;
    readonly exitCode: number;

    constructor(output: string, error: string, exitCode: number) {
        this.output = output;
        this.error = error;
        this.exitCode = exitCode;
        this.ok = exitCode === 0;
    }

    toString(): string { return this.output; }
    toJSON(): string { return this.output; }

    static success(output: string): ToolResult {
        return new ToolResult(output, "", 0);
    }
    static fail(error: string, output: string = ""): ToolResult {
        return new ToolResult(output, error, 1);
    }
}

export type ToolWrappers = Record<string, (args: Record<string, unknown>) => Promise<ToolResult>>;

/** Max output size for bash commands (matches pi's default). */
const BASH_MAX_BYTES = 50 * 1024;

/** Run a bash command, returning structured ToolResult. Never throws on non-zero exit. */
function execBash(command: string, cwd: string, timeout?: number): Promise<ToolResult> {
    return new Promise((resolve) => {
        const proc = spawn("bash", ["-c", command], {
            cwd,
            env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
            stdio: ["ignore", "pipe", "pipe"],
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;

        proc.stdout!.on("data", (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes <= BASH_MAX_BYTES) stdoutChunks.push(chunk);
        });
        proc.stderr!.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.length;
            if (stderrBytes <= BASH_MAX_BYTES) stderrChunks.push(chunk);
        });

        let timer: ReturnType<typeof setTimeout> | undefined;
        if (timeout && timeout > 0) {
            timer = setTimeout(() => { proc.kill("SIGTERM"); }, timeout * 1000);
        }

        proc.on("close", (code) => {
            if (timer) clearTimeout(timer);
            let stdout = Buffer.concat(stdoutChunks).toString("utf-8");
            let stderr = Buffer.concat(stderrChunks).toString("utf-8");
            if (stdoutBytes > BASH_MAX_BYTES) {
                stdout += `\n[truncated: ${stdoutBytes} bytes total, showing first ${BASH_MAX_BYTES}]`;
            }
            if (stderrBytes > BASH_MAX_BYTES) {
                stderr += `\n[truncated: ${stderrBytes} bytes total, showing first ${BASH_MAX_BYTES}]`;
            }
            resolve(new ToolResult(stdout, stderr, code ?? 1));
        });

        proc.on("error", (err) => {
            if (timer) clearTimeout(timer);
            resolve(new ToolResult("", err.message, 1));
        });
    });
}

export function createToolWrappers(cwd: string): ToolWrappers {
    const tools: Record<string, any> = {
        read: createReadTool(cwd),
        edit: createEditTool(cwd),
        write: createWriteTool(cwd),
        grep: createGrepTool(cwd),
        find: createFindTool(cwd),
        ls: createLsTool(cwd),
    };

    const wrappers: ToolWrappers = {};

    // bash gets a custom implementation with separated stdout/stderr
    wrappers["bash"] = async (args: Record<string, unknown>) => {
        return execBash(args.command as string, cwd, args.timeout as number | undefined);
    };

    for (const [name, tool] of Object.entries(tools)) {
        wrappers[name] = async (args: Record<string, unknown>) => {
            try {
                const result = await tool.execute(`spindle-${name}-${Date.now()}`, args);
                return ToolResult.success(extractText(result));
            } catch (err: any) {
                return ToolResult.fail(err.message || String(err));
            }
        };
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
