/**
 * Subagent management — async agents in tmux sessions with optional git worktree isolation.
 *
 * subagent() creates a tmux session (and optionally a worktree), starts a pi
 * process, and returns a handle immediately. The main agent keeps working.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverAgents, resolveAgent, getExtensionDir } from "./agents.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubagentStatus = "running" | "done" | "crashed";

export interface AgentResult {
    // Episode
    status: "success" | "failure" | "blocked";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];

    // Raw output
    text: string;
    ok: boolean;

    // Execution metadata
    cost: number;
    model: string;
    turns: number;
    toolCalls: number;
    durationMs: number;
    exitCode: number;

    // Worktree (undefined when worktree: false)
    branch?: string;
    worktree?: string;
}

export interface StatusFileEpisode {
    status: "success" | "failure" | "blocked";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];
}

export interface StatusFile {
    status: SubagentStatus;
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
    text?: string;
    episode?: StatusFileEpisode;
    lastUpdate: number;
}

export interface SubagentOptions {
    name?: string;
    agent?: string;
    model?: string;
    tools?: string[];
    timeout?: number;
    worktree?: boolean;
    systemPromptSuffix?: string;
}

export interface SubagentHandle {
    readonly id: string;
    readonly task: string;
    readonly session: string;
    readonly startTime: number;
    readonly branch?: string;
    readonly worktree?: string;
    readonly status: SubagentStatus;
    readonly result: Promise<AgentResult>;
    cancel(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Subagent Manager
// ---------------------------------------------------------------------------

let counter = 0;
const active = new Map<string, SubagentHandleImpl>();

/** Find the next available ID that doesn't collide with existing tmux sessions. */
function nextId(): string {
    while (true) {
        const id = `w${counter++}`;
        const session = `spindle-${id}`;
        if (!tmuxSessionExists(session)) return id;
        // Session exists from a previous run — skip it
    }
}

export interface SubagentCallbacks {
    onStatusChange?: (handle: SubagentHandle) => void;
    onDone?: (handle: SubagentHandle, result: AgentResult) => void;
}

let callbacks: SubagentCallbacks = {};

export function setSubagentCallbacks(cb: SubagentCallbacks): void {
    callbacks = cb;
}

export function getActiveSubagents(): Map<string, SubagentHandle> {
    return active as Map<string, SubagentHandle>;
}

export function getSubagent(id: string): SubagentHandle | undefined {
    return active.get(id);
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

    fs.mkdirSync(path.join(gitRoot, ".worktrees"), { recursive: true });

    // Add .worktrees to .gitignore if not already there
    const gitignorePath = path.join(gitRoot, ".gitignore");
    let gitignore = "";
    try { gitignore = fs.readFileSync(gitignorePath, "utf-8"); } catch {}
    if (!gitignore.includes(".worktrees")) {
        fs.appendFileSync(gitignorePath, "\n.worktrees/\n");
    }

    execSync(`git worktree add ${JSON.stringify(worktreeDir)} -b ${JSON.stringify(branch)}`, {
        cwd: gitRoot, stdio: "pipe",
    });

    return { worktree: worktreeDir, branch };
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
    } catch {}
}

/** Check if the pi process is still running inside a tmux session's pane. */
function isTmuxPaneAlive(session: string): boolean {
    try {
        const cmd = execSync(
            `tmux list-panes -t ${JSON.stringify(session)} -F "#{pane_current_command}"`,
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        ).trim();
        // If the current command is a shell (bash, zsh, fish, etc.), pi has exited
        return !/^(bash|zsh|fish|sh|dash)$/i.test(cmd);
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Status file helpers
// ---------------------------------------------------------------------------

const STATUS_DIR = ".spindle";
const STATUS_FILE = "status.json";

export { isTmuxPaneAlive, killTmuxSession };

export function readStatusFile(dir: string): StatusFile | null {
    const filePath = path.join(dir, STATUS_DIR, STATUS_FILE);
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as StatusFile;
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

    const jsPath = path.join(extDir, "worker-extension.js");
    const tsPath = path.join(extDir, "worker-extension.ts");
    if (fs.existsSync(jsPath)) return jsPath;
    if (fs.existsSync(tsPath)) return tsPath;

    throw new Error(`Worker extension not found at ${jsPath} or ${tsPath}`);
}

// ---------------------------------------------------------------------------
// Build pi command
// ---------------------------------------------------------------------------

function buildPiCommand(
    task: string,
    opts: SubagentOptions,
    workerExtPath: string,
    cwd: string,
    statusDir: string,
): string {
    // SPINDLE_STATUS_DIR tells the worker extension where to write status.json
    const envPrefix = `SPINDLE_STATUS_DIR=${JSON.stringify(statusDir)}`;
    const args: string[] = [envPrefix, "pi", "--no-session"];
    args.push("-e", workerExtPath);

    const agents = discoverAgents(cwd);
    const agentConfig = opts.agent ? resolveAgent(agents, opts.agent) : undefined;

    const model = opts.model ?? agentConfig?.model;
    if (model) args.push("--model", model);

    const tools = opts.tools ?? agentConfig?.tools;
    if (tools?.length) args.push("--tools", tools.join(","));

    const promptParts: string[] = [];
    if (agentConfig?.systemPrompt?.trim()) promptParts.push(agentConfig.systemPrompt);
    if (opts.systemPromptSuffix?.trim()) promptParts.push(opts.systemPromptSuffix);

    if (promptParts.length > 0) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-sub-"));
        const tmpFile = path.join(tmpDir, "prompt.md");
        fs.writeFileSync(tmpFile, promptParts.join("\n\n"), { encoding: "utf-8", mode: 0o600 });
        args.push("--append-system-prompt", tmpFile);
    }

    args.push(JSON.stringify(`Task: ${task}`));
    return args.join(" ");
}

// ---------------------------------------------------------------------------
// SubagentHandle implementation
// ---------------------------------------------------------------------------

function emptyResult(handle: SubagentHandleImpl, summary: string): AgentResult {
    return {
        status: "failure",
        summary,
        findings: [],
        artifacts: [],
        blockers: [],
        text: "",
        ok: false,
        cost: 0,
        model: "unknown",
        turns: 0,
        toolCalls: 0,
        durationMs: Date.now() - handle.startTime,
        exitCode: -1,
        branch: handle.branch,
        worktree: handle.worktree,
    };
}

class SubagentHandleImpl implements SubagentHandle {
    readonly id: string;
    readonly task: string;
    readonly session: string;
    readonly startTime: number;
    readonly branch?: string;
    readonly worktree?: string;
    /** Directory where .spindle/status.json lives — worktree dir or cwd. */
    readonly statusDir: string;
    private _result: Promise<AgentResult>;
    private _resolveResult!: (result: AgentResult) => void;
    private _resolved = false;

    /** Grace period (ms) before we start checking if the pane process is alive.
     *  Needed because tmux send-keys hasn't launched pi yet when the poller first runs. */
    static readonly STARTUP_GRACE_MS = 15_000;

    constructor(
        id: string, task: string, session: string,
        statusDir: string, branch?: string, worktree?: string,
    ) {
        this.id = id;
        this.task = task;
        this.session = session;
        this.startTime = Date.now();
        this.statusDir = statusDir;
        this.branch = branch;
        this.worktree = worktree;
        this._result = new Promise<AgentResult>((resolve) => {
            this._resolveResult = resolve;
        });
    }

    /** Whether the startup grace period has elapsed. */
    get pastGrace(): boolean {
        return Date.now() - this.startTime > SubagentHandleImpl.STARTUP_GRACE_MS;
    }

    get status(): SubagentStatus {
        const sf = readStatusFile(this.statusDir);
        if (sf) return sf.status;
        if (!tmuxSessionExists(this.session)) return "crashed";
        return "running";
    }

    get result(): Promise<AgentResult> {
        return this._result;
    }

    _resolve(result: AgentResult): void {
        if (this._resolved) return;
        this._resolved = true;
        this._resolveResult(result);
    }

    get resolved(): boolean {
        return this._resolved;
    }

    async cancel(): Promise<void> {
        killTmuxSession(this.session);
        const result = emptyResult(this, "Cancelled by user");
        this._resolve(result);
        active.delete(this.id);
        callbacks.onDone?.(this, result);
    }
}

// ---------------------------------------------------------------------------
// subagent()
// ---------------------------------------------------------------------------

export function subagent(
    task: string,
    opts: SubagentOptions = {},
    defaultCwd: string = process.cwd(),
    defaultModel?: string,
): SubagentHandle {
    if (!hasTmux()) {
        throw new Error("tmux is required for subagents. Install tmux and try again.");
    }

    const id = nextId();
    const sessionName = `spindle-${id}`;
    const useWorktree = opts.worktree === true;

    let branch: string | undefined;
    let worktreeDir: string | undefined;
    let statusDir: string;
    let agentCwd: string;

    if (useWorktree) {
        const gitRoot = getGitRoot(defaultCwd);
        if (!gitRoot) {
            throw new Error("Cannot create worktree: not in a git repository. Use { worktree: false }.");
        }
        const wt = createWorktree(gitRoot, id);
        worktreeDir = wt.worktree;
        branch = wt.branch;
        statusDir = worktreeDir;
        agentCwd = worktreeDir;
    } else {
        // Each non-worktree subagent gets a unique status directory
        // so multiple subagents sharing a cwd don't clobber each other's status files.
        statusDir = fs.mkdtempSync(path.join(os.tmpdir(), `spindle-status-${id}-`));
        agentCwd = defaultCwd;
    }

    const workerExtPath = getWorkerExtensionPath();
    const command = buildPiCommand(
        task,
        { ...opts, model: opts.model ?? defaultModel },
        workerExtPath,
        agentCwd,
        statusDir,
    );

    createTmuxSession(sessionName, agentCwd, command);

    const handle = new SubagentHandleImpl(
        id, task, sessionName, statusDir, branch, worktreeDir,
    );
    active.set(id, handle);
    callbacks.onStatusChange?.(handle);

    return handle;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function killAllSubagents(): void {
    for (const [, handle] of active) {
        if (!handle.resolved) {
            killTmuxSession(handle.session);
            handle._resolve(emptyResult(handle, "Session ended — subagent killed"));
        }
    }
    active.clear();
}

export function resetCounter(): void {
    counter = 0;
}
