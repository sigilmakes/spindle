/**
 * Worker management — async subagents in tmux sessions with git worktree isolation.
 *
 * spawn() creates a worktree, starts a tmux session with a pi process,
 * and returns a handle immediately. The main agent keeps working.
 */

import { execSync, spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverAgents, resolveAgent, getExtensionDir } from "./agents.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkerStatus = "running" | "done" | "crashed";

export interface WorkerEpisode {
    status: "success" | "failure" | "blocked";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];
}

export interface WorkerStatusFile {
    status: WorkerStatus;
    currentTool?: string;
    currentArgs?: string;
    startTime: number;
    endTime?: number;
    turns: number;
    toolCalls: number;
    cost: number;
    model?: string;
    exitCode?: number;
    summary?: string;
    episode?: WorkerEpisode;
    lastUpdate: number;
}

export interface WorkerResult {
    status: "success" | "failure";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];
    branch: string;
    worktree: string;
    exitCode: number;
    turns: number;
    toolCalls: number;
    cost: number;
    model: string;
    durationMs: number;
}

export interface SpawnOptions {
    name?: string;
    agent?: string;
    model?: string;
    tools?: string[];
    timeout?: number;
    worktree?: boolean;
    systemPromptSuffix?: string;
}

export interface WorkerHandle {
    readonly id: string;
    readonly branch: string;
    readonly worktree: string;
    readonly session: string;
    readonly task: string;
    readonly startTime: number;
    readonly status: WorkerStatus;
    readonly result: Promise<WorkerResult>;
    cancel(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Worker Manager
// ---------------------------------------------------------------------------

let workerCounter = 0;
const activeWorkers = new Map<string, WorkerHandleImpl>();

/** Callbacks for external integration (dashboard, notifications). */
export interface WorkerCallbacks {
    onStatusChange?: (handle: WorkerHandle) => void;
    onWorkerDone?: (handle: WorkerHandle, result: WorkerResult) => void;
}

let callbacks: WorkerCallbacks = {};

export function setWorkerCallbacks(cb: WorkerCallbacks): void {
    callbacks = cb;
}

export function getActiveWorkers(): Map<string, WorkerHandle> {
    return activeWorkers as Map<string, WorkerHandle>;
}

export function getWorker(id: string): WorkerHandle | undefined {
    return activeWorkers.get(id);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function getGitRoot(cwd: string): string | null {
    try {
        return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
    } catch {
        return null;
    }
}

function createWorktree(gitRoot: string, id: string): { worktree: string; branch: string } {
    const branch = `spindle/${id}`;
    const worktreeDir = path.join(gitRoot, ".worktrees", id);

    // Ensure .worktrees directory exists
    fs.mkdirSync(path.join(gitRoot, ".worktrees"), { recursive: true });

    // Add .worktrees to .gitignore if not already there
    const gitignorePath = path.join(gitRoot, ".gitignore");
    let gitignore = "";
    try { gitignore = fs.readFileSync(gitignorePath, "utf-8"); } catch { /* no gitignore */ }
    if (!gitignore.includes(".worktrees")) {
        fs.appendFileSync(gitignorePath, "\n.worktrees/\n");
    }

    execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(branch)}`, {
        cwd: gitRoot,
        stdio: "pipe",
    });

    return { worktree: worktreeDir, branch };
}

function removeWorktree(gitRoot: string, worktreeDir: string, branch: string): void {
    try {
        execSync(`git worktree remove ${JSON.stringify(worktreeDir)} --force`, {
            cwd: gitRoot,
            stdio: "pipe",
        });
    } catch { /* already removed */ }
    try {
        execSync(`git branch -D ${JSON.stringify(branch)}`, {
            cwd: gitRoot,
            stdio: "pipe",
        });
    } catch { /* already deleted */ }
}

// ---------------------------------------------------------------------------
// Tmux helpers
// ---------------------------------------------------------------------------

function hasTmux(): boolean {
    try {
        execSync("tmux -V", { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function tmuxSessionExists(session: string): boolean {
    try {
        execSync(`tmux has-session -t ${JSON.stringify(session)}`, { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function createTmuxSession(session: string, cwd: string, command: string): void {
    execSync(
        `tmux new-session -d -s ${JSON.stringify(session)} -c ${JSON.stringify(cwd)}`,
        { stdio: "pipe" },
    );
    execSync(
        `tmux send-keys -t ${JSON.stringify(session)} ${JSON.stringify(command)} Enter`,
        { stdio: "pipe" },
    );
}

function killTmuxSession(session: string): void {
    try {
        execSync(`tmux kill-session -t ${JSON.stringify(session)}`, { stdio: "pipe" });
    } catch { /* already dead */ }
}

// ---------------------------------------------------------------------------
// Status file helpers
// ---------------------------------------------------------------------------

const STATUS_DIR = ".spindle";
const STATUS_FILE = "status.json";

function readStatusFile(worktreeDir: string): WorkerStatusFile | null {
    const filePath = path.join(worktreeDir, STATUS_DIR, STATUS_FILE);
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as WorkerStatusFile;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Worker extension path
// ---------------------------------------------------------------------------

function getWorkerExtensionPath(): string {
    const extDir = getExtensionDir();
    if (!extDir) throw new Error("Spindle extension directory not set");

    // Look for worker-extension.js (compiled) or worker-extension.ts (source)
    const jsPath = path.join(extDir, "worker-extension.js");
    const tsPath = path.join(extDir, "worker-extension.ts");
    if (fs.existsSync(jsPath)) return jsPath;
    if (fs.existsSync(tsPath)) return tsPath;

    throw new Error(`Worker extension not found at ${jsPath} or ${tsPath}`);
}

// ---------------------------------------------------------------------------
// Build pi command for worker
// ---------------------------------------------------------------------------

function buildPiCommand(
    task: string,
    opts: SpawnOptions,
    workerExtPath: string,
    cwd: string,
): string {
    const args: string[] = ["pi", "-p", "--no-session"];
    args.push("-e", workerExtPath);

    const agents = discoverAgents(cwd);
    const agentConfig = opts.agent ? resolveAgent(agents, opts.agent) : undefined;

    const model = opts.model ?? agentConfig?.model;
    if (model) args.push("--model", model);

    const tools = opts.tools ?? agentConfig?.tools;
    if (tools?.length) args.push("--tools", tools.join(","));

    // Build the system prompt suffix as a temp file
    const promptParts: string[] = [];
    if (agentConfig?.systemPrompt?.trim()) promptParts.push(agentConfig.systemPrompt);
    if (opts.systemPromptSuffix?.trim()) promptParts.push(opts.systemPromptSuffix);

    if (promptParts.length > 0) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-worker-"));
        const tmpFile = path.join(tmpDir, "prompt.md");
        fs.writeFileSync(tmpFile, promptParts.join("\n\n"), { encoding: "utf-8", mode: 0o600 });
        args.push("--append-system-prompt", tmpFile);
    }

    // Quote the task for shell
    args.push(JSON.stringify(`Task: ${task}`));

    return args.join(" ");
}

// ---------------------------------------------------------------------------
// Fallback: non-git temp directory
// ---------------------------------------------------------------------------

function createTempWorktree(id: string): { worktree: string; branch: string } {
    const dir = path.join(os.tmpdir(), `spindle-worker-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    return { worktree: dir, branch: `spindle/${id}` };
}

// ---------------------------------------------------------------------------
// WorkerHandle implementation
// ---------------------------------------------------------------------------

class WorkerHandleImpl implements WorkerHandle {
    readonly id: string;
    readonly branch: string;
    readonly worktree: string;
    readonly session: string;
    readonly task: string;
    readonly startTime: number;
    private _result: Promise<WorkerResult>;
    private _resolveResult!: (result: WorkerResult) => void;
    private _resolved = false;
    private _gitRoot: string | null;
    private _isGitWorktree: boolean;

    constructor(
        id: string,
        branch: string,
        worktree: string,
        session: string,
        task: string,
        gitRoot: string | null,
        isGitWorktree: boolean,
    ) {
        this.id = id;
        this.branch = branch;
        this.worktree = worktree;
        this.session = session;
        this.task = task;
        this.startTime = Date.now();
        this._gitRoot = gitRoot;
        this._isGitWorktree = isGitWorktree;

        this._result = new Promise<WorkerResult>((resolve) => {
            this._resolveResult = resolve;
        });
    }

    get status(): WorkerStatus {
        const sf = readStatusFile(this.worktree);
        if (sf) return sf.status;

        // No status file yet — check if tmux session is alive
        if (!tmuxSessionExists(this.session)) return "crashed";
        return "running";
    }

    get result(): Promise<WorkerResult> {
        return this._result;
    }

    /** Called by the poller when the worker is detected as finished. */
    _resolve(result: WorkerResult): void {
        if (this._resolved) return;
        this._resolved = true;
        this._resolveResult(result);
    }

    get resolved(): boolean {
        return this._resolved;
    }

    async cancel(): Promise<void> {
        killTmuxSession(this.session);

        // Don't remove worktree — preserve work for inspection
        this._resolve({
            status: "failure",
            summary: "Cancelled by user",
            findings: [],
            artifacts: [],
            blockers: [],
            branch: this.branch,
            worktree: this.worktree,
            exitCode: -1,
            turns: 0,
            toolCalls: 0,
            cost: 0,
            model: "unknown",
            durationMs: Date.now() - this.startTime,
        });

        activeWorkers.delete(this.id);
        callbacks.onWorkerDone?.(this, await this._result);
    }
}

// ---------------------------------------------------------------------------
// spawn()
// ---------------------------------------------------------------------------

export function spawn(
    task: string,
    opts: SpawnOptions = {},
    defaultCwd: string = process.cwd(),
    defaultModel?: string,
): WorkerHandle {
    if (!hasTmux()) {
        throw new Error("tmux is required for async workers. Install tmux and try again.");
    }

    const id = `w${workerCounter++}`;
    const sessionName = `spindle-${id}`;
    const useWorktree = opts.worktree !== false;

    const gitRoot = getGitRoot(defaultCwd);
    let worktreeDir: string;
    let branch: string;
    let isGitWorktree: boolean;

    if (useWorktree && gitRoot) {
        const wt = createWorktree(gitRoot, id);
        worktreeDir = wt.worktree;
        branch = wt.branch;
        isGitWorktree = true;
    } else {
        // Non-git fallback: use a temp directory
        const tmp = createTempWorktree(id);
        worktreeDir = tmp.worktree;
        branch = tmp.branch;
        isGitWorktree = false;

        // Copy the current directory contents to the temp dir if in a project
        if (useWorktree) {
            // Just use the defaultCwd directly — no isolation
            worktreeDir = defaultCwd;
        }
    }

    const workerExtPath = getWorkerExtensionPath();
    const command = buildPiCommand(task, { ...opts, model: opts.model ?? defaultModel }, workerExtPath, worktreeDir);

    // Create the tmux session and start pi
    createTmuxSession(sessionName, worktreeDir, command);

    const handle = new WorkerHandleImpl(
        id, branch, worktreeDir, sessionName, task, gitRoot, isGitWorktree,
    );
    activeWorkers.set(id, handle);

    callbacks.onStatusChange?.(handle);

    return handle;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Kill all running workers. Called on session shutdown. */
export function killAllWorkers(): void {
    for (const [id, handle] of activeWorkers) {
        if (!handle.resolved) {
            killTmuxSession(handle.session);
            handle._resolve({
                status: "failure",
                summary: "Session ended — worker killed",
                findings: [],
                artifacts: [],
                blockers: [],
                branch: handle.branch,
                worktree: handle.worktree,
                exitCode: -1,
                turns: 0,
                toolCalls: 0,
                cost: 0,
                model: "unknown",
                durationMs: Date.now() - handle.startTime,
            });
        }
    }
    activeWorkers.clear();
}

/** Reset the worker counter (for testing). */
export function resetWorkerCounter(): void {
    workerCounter = 0;
}
