import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverAgents, resolveAgent, getExtensionDir } from "./agents.js";
import { EPISODE_PROMPT, parseEpisodeBlock } from "./episode.js";

export type SubagentStatus = "running" | "done" | "crashed";

export interface AgentResult {
    status: "success" | "failure" | "blocked";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];
    text: string;
    ok: boolean;
    cost: number;
    model: string;
    turns: number;
    toolCalls: number;
    durationMs: number;
    exitCode: number;
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
    readonly resolved: boolean;
    readonly awaited: boolean;
    readonly statusDir: string;
    readonly pastGrace: boolean;
    cancel(): Promise<void>;
    _resolve(result: AgentResult): void;
}

export interface CleanupResult {
    removedWorktrees: string[];
    removedBranches: string[];
    removedSessions: string[];
    errors: string[];
}

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

function getGitRoot(cwd: string): string | null {
    try {
        return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    } catch {
        return null;
    }
}

function createWorktree(gitRoot: string, name: string): { worktree: string; branch: string } {
    const safeName = (name || "spindle").replace(/[^a-zA-Z0-9._-]+/g, "-");
    const suffix = Date.now().toString(36);
    const branch = `spindle/${safeName}-${suffix}`;
    const worktreeDir = path.join(gitRoot, ".worktrees", `${safeName}-${suffix}`);

    fs.mkdirSync(path.join(gitRoot, ".worktrees"), { recursive: true });

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

function killTmuxSession(session: string): void {
    try {
        execSync(`tmux kill-session -t ${JSON.stringify(session)}`, { stdio: "pipe" });
    } catch {}
}

function isTmuxPaneAlive(session: string): boolean {
    try {
        const cmd = execSync(
            `tmux list-panes -t ${JSON.stringify(session)} -F "#{pane_current_command}"`,
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        ).trim();
        return !/^(bash|zsh|fish|sh|dash)$/i.test(cmd);
    } catch {
        return false;
    }
}

function getMainExtensionPath(): string {
    const extDir = getExtensionDir();
    if (!extDir) throw new Error("Spindle extension directory not set");

    const jsPath = path.join(extDir, "index.js");
    const tsPath = path.join(extDir, "index.ts");
    if (fs.existsSync(jsPath)) return jsPath;
    if (fs.existsSync(tsPath)) return tsPath;
    throw new Error(`Spindle extension entry not found at ${jsPath} or ${tsPath}`);
}

function buildSystemPrompt(cwd: string, opts: SubagentOptions): string | undefined {
    const promptParts: string[] = [];
    const agents = discoverAgents(cwd);
    const agentConfig = opts.agent ? resolveAgent(agents, opts.agent) : undefined;

    if (agentConfig?.systemPrompt?.trim()) promptParts.push(agentConfig.systemPrompt);
    if (opts.systemPromptSuffix?.trim()) promptParts.push(opts.systemPromptSuffix);
    promptParts.push(EPISODE_PROMPT);

    const combined = promptParts.filter(Boolean).join("\n\n").trim();
    return combined || undefined;
}

function extractLastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as any;
        if (msg?.role !== "assistant") continue;
        for (const part of msg.content || []) {
            if (part?.type === "text") return String(part.text || "");
        }
    }
    return "";
}

async function runRpcAgent(
    cwd: string,
    task: string,
    opts: SubagentOptions,
    extensionPath: string,
): Promise<{ text: string; exitCode: number; turns: number; toolCalls: number; cost: number; model: string }> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-sub-"));
    const promptFile = path.join(tempDir, "prompt.md");
    const systemPrompt = buildSystemPrompt(cwd, opts);
    if (systemPrompt) {
        fs.writeFileSync(promptFile, systemPrompt, { encoding: "utf-8", mode: 0o600 });
    }

    const args = ["--mode", "rpc", "--no-session"];
    const extensionRoot = path.dirname(path.dirname(extensionPath));
    const normalizedCwd = path.resolve(cwd);
    const normalizedExtensionRoot = path.resolve(extensionRoot);
    if (!normalizedCwd.startsWith(normalizedExtensionRoot)) {
        args.push("-e", extensionPath);
    }
    if (opts.model) args.push("--model", opts.model);
    if (opts.tools?.length) args.push("--tools", opts.tools.join(","));
    if (systemPrompt) args.push("--append-system-prompt", promptFile);

    const proc = spawn("pi", args, {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderr = "";
    let assistantText = "";
    let turns = 0;
    let toolCalls = 0;
    let cost = 0;
    let model = "unknown";
    let settled = false;
    let promptAccepted = false;
    let sawAgentEnd = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
        if (killTimer) clearTimeout(killTimer);
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    };

    const send = (payload: Record<string, unknown>) => {
        proc.stdin.write(JSON.stringify(payload) + "\n");
    };

    const finish = (
        resolve: (value: { text: string; exitCode: number; turns: number; toolCalls: number; cost: number; model: string }) => void,
        exitCode: number,
    ) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ text: assistantText, exitCode, turns, toolCalls, cost, model });
    };

    const fail = (reject: (reason?: unknown) => void, reason: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(reason);
    };

    return await new Promise((resolve, reject) => {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        if (opts.timeout && opts.timeout > 0) {
            timeoutHandle = setTimeout(() => {
                try { proc.kill("SIGTERM"); } catch {}
            }, opts.timeout * 1000);
        }

        proc.stdout.on("data", (chunk) => {
            stdoutBuf += chunk.toString("utf-8");
            while (true) {
                const idx = stdoutBuf.indexOf("\n");
                if (idx < 0) break;
                const line = stdoutBuf.slice(0, idx).replace(/\r$/, "");
                stdoutBuf = stdoutBuf.slice(idx + 1);
                if (!line.trim()) continue;

                let msg: any;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }

                if (msg.type === "response" && msg.command === "prompt") {
                    if (msg.success) {
                        promptAccepted = true;
                    } else {
                        fail(reject, new Error(msg.error || "Subagent prompt rejected"));
                        return;
                    }
                } else if (msg.type === "turn_end") {
                    turns++;
                    const usage = msg.message?.usage;
                    if (usage?.cost?.total) cost += usage.cost.total;
                    if (msg.message?.model && model === "unknown") model = msg.message.model;
                    if (Array.isArray(msg.toolResults)) toolCalls += msg.toolResults.length;
                } else if (msg.type === "tool_execution_end") {
                    if (!Array.isArray(msg.toolResults)) toolCalls++;
                } else if (msg.type === "agent_end") {
                    sawAgentEnd = true;
                    assistantText = extractLastAssistantText(msg.messages || []);
                    try { proc.stdin.end(); } catch {}
                    killTimer = setTimeout(() => {
                        try { proc.kill("SIGTERM"); } catch {}
                    }, 500);
                } else if (msg.type === "extension_ui_request") {
                    const method = String(msg.method || "");
                    if (["select", "confirm", "input", "editor"].includes(method) && msg.id) {
                        send({ type: "extension_ui_response", id: msg.id, cancelled: true });
                    }
                }
            }
        });

        proc.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf-8");
        });

        proc.on("error", (err) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            fail(reject, err);
        });
        proc.on("close", (code) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (!promptAccepted && stderr.trim()) {
                fail(reject, new Error(stderr.trim()));
                return;
            }
            if (!sawAgentEnd && stderr.trim()) {
                assistantText = assistantText || stderr.trim();
            }
            finish(resolve, code ?? 1);
        });

        send({ id: "prompt-1", type: "prompt", message: task });
    });
}

function buildResult(
    text: string,
    exitCode: number,
    startTime: number,
    turns: number,
    toolCalls: number,
    cost: number,
    model: string,
    branch?: string,
    worktree?: string,
): AgentResult {
    const episode = parseEpisodeBlock(text);
    const status = episode?.status || (exitCode === 0 ? "success" : "failure");
    const summary = episode?.summary || text.trim() || (exitCode === 0 ? "Subagent completed." : "Subagent failed.");
    return {
        status,
        summary,
        findings: episode?.findings || [],
        artifacts: episode?.artifacts || [],
        blockers: episode?.blockers || [],
        text,
        ok: status === "success",
        cost,
        model,
        turns,
        toolCalls,
        durationMs: Date.now() - startTime,
        exitCode,
        branch,
        worktree,
    };
}

export async function subagent(
    task: string,
    opts: SubagentOptions = {},
    defaultCwd: string = process.cwd(),
    defaultModel?: string,
): Promise<AgentResult> {
    const startTime = Date.now();
    const effectiveOpts = { ...opts, model: opts.model ?? defaultModel };

    let cwd = defaultCwd;
    let branch: string | undefined;
    let worktree: string | undefined;

    if (effectiveOpts.worktree) {
        const gitRoot = getGitRoot(defaultCwd);
        if (!gitRoot) {
            throw new Error("Cannot create worktree: not in a git repository. Use { worktree: false }.");
        }
        const wt = createWorktree(gitRoot, effectiveOpts.name || "spindle");
        cwd = wt.worktree;
        branch = wt.branch;
        worktree = wt.worktree;
    }

    const extensionPath = getMainExtensionPath();
    const { text, exitCode, turns, toolCalls, cost, model } = await runRpcAgent(cwd, task, effectiveOpts, extensionPath);

    return buildResult(text, exitCode, startTime, turns, toolCalls, cost, model, branch, worktree);
}

export function killAllSubagents(): void {
    // Synchronous subagents no longer keep background state in the main process.
}

export function resetCounter(): void {
    // Legacy no-op retained for tests.
}

export function getActiveSubagents(): Map<string, SubagentHandle> {
    return new Map();
}

export function getSubagent(_id: string): SubagentHandle | undefined {
    return undefined;
}

export function cleanupWorktrees(cwd: string): CleanupResult {
    const result: CleanupResult = {
        removedWorktrees: [],
        removedBranches: [],
        removedSessions: [],
        errors: [],
    };

    const gitRoot = getGitRoot(cwd);
    if (!gitRoot) return result;

    const worktreesDir = path.join(gitRoot, ".worktrees");
    if (fs.existsSync(worktreesDir)) {
        try {
            for (const entry of fs.readdirSync(worktreesDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const wtPath = path.join(worktreesDir, entry.name);
                try {
                    execSync(`git worktree remove ${JSON.stringify(wtPath)} --force`, {
                        cwd: gitRoot, stdio: "pipe",
                    });
                    result.removedWorktrees.push(entry.name);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    result.errors.push(`worktree ${entry.name}: ${msg}`);
                }
            }
        } catch {}
    }

    try {
        execSync("git worktree prune", { cwd: gitRoot, stdio: "pipe" });
    } catch {}

    try {
        const branches = execSync("git branch --list 'spindle/*'", {
            cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }).trim().split("\n").map((b) => b.trim().replace(/^\*\s*/, "")).filter(Boolean);

        for (const branch of branches) {
            try {
                execSync(`git branch -D ${JSON.stringify(branch)}`, {
                    cwd: gitRoot, stdio: "pipe",
                });
                result.removedBranches.push(branch);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                result.errors.push(`branch ${branch}: ${msg}`);
            }
        }
    } catch {}

    if (hasTmux()) {
        try {
            const sessions = execSync("tmux list-sessions -F '#{session_name}'", {
                encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            }).trim().split("\n").filter((s) => s.startsWith("spindle-"));

            for (const session of sessions) {
                killTmuxSession(session);
                result.removedSessions.push(session);
            }
        } catch {}
    }

    return result;
}
