/**
 * Integration tests for subagent lifecycle: spawn, poll, complete, cleanup.
 *
 * These tests use real tmux sessions and real git repos. They are designed to
 * be safe (use temp dirs, clean up after themselves) but require tmux and git.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import {
    readStatusFile, isTmuxPaneAlive, killTmuxSession,
    killAllSubagents, getActiveSubagents, resetCounter,
    cleanupWorktrees,
    type StatusFile,
} from "../src/workers.js";
import { startPoller, stopPoller, isPollerRunning } from "../src/poller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-integ-"));
    tmpDirs.push(dir);
    return dir;
}

function initGitRepo(dir: string): void {
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
    execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
    fs.writeFileSync(path.join(dir, "README.md"), "test");
    execSync("git add -A && git commit -m init", { cwd: dir, stdio: "pipe" });
}

function tmuxSessionExists(session: string): boolean {
    try {
        execSync(`tmux has-session -t ${JSON.stringify(session)}`, { stdio: "pipe" });
        return true;
    } catch {
        return false;
    }
}

function createTmuxSession(session: string, cwd: string): void {
    execSync(
        `tmux new-session -d -s ${JSON.stringify(session)} -c ${JSON.stringify(cwd)}`,
        { stdio: "pipe" },
    );
}

// ---------------------------------------------------------------------------
// readStatusFile
// ---------------------------------------------------------------------------

describe("readStatusFile", () => {
    let tmp: string;
    beforeEach(() => { tmp = makeTmpDir(); });

    it("returns null when no status file exists", () => {
        expect(readStatusFile(tmp)).toBeNull();
    });

    it("reads a valid status file", () => {
        const dir = path.join(tmp, ".spindle");
        fs.mkdirSync(dir, { recursive: true });
        const status: StatusFile = {
            status: "running",
            startTime: Date.now(),
            turns: 3,
            toolCalls: 5,
            cost: 0.01,
            model: "test-model",
            lastUpdate: Date.now(),
        };
        fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));

        const result = readStatusFile(tmp);
        expect(result).not.toBeNull();
        expect(result!.status).toBe("running");
        expect(result!.turns).toBe(3);
        expect(result!.model).toBe("test-model");
    });

    it("reads a completed status file with episode data", () => {
        const dir = path.join(tmp, ".spindle");
        fs.mkdirSync(dir, { recursive: true });
        const status: StatusFile = {
            status: "done",
            startTime: Date.now() - 5000,
            endTime: Date.now(),
            turns: 2,
            toolCalls: 4,
            cost: 0.05,
            model: "test-model",
            exitCode: 0,
            summary: "Task completed successfully",
            episode: {
                status: "success",
                summary: "Found 3 issues",
                findings: ["Issue 1", "Issue 2", "Issue 3"],
                artifacts: ["src/fix.ts"],
                blockers: [],
            },
            lastUpdate: Date.now(),
        };
        fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));

        const result = readStatusFile(tmp);
        expect(result!.status).toBe("done");
        expect(result!.exitCode).toBe(0);
        expect(result!.episode?.findings).toHaveLength(3);
    });

    it("returns null for malformed JSON", () => {
        const dir = path.join(tmp, ".spindle");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "status.json"), "not json{{{");

        expect(readStatusFile(tmp)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// tmux session helpers
// ---------------------------------------------------------------------------

describe("tmux helpers", () => {
    const SESSION = "spindle-test-integ-helpers";

    afterEach(() => {
        try { execSync(`tmux kill-session -t ${SESSION}`, { stdio: "pipe" }); } catch {}
    });

    it("detects a live tmux session", () => {
        const tmp = makeTmpDir();
        createTmuxSession(SESSION, tmp);
        expect(tmuxSessionExists(SESSION)).toBe(true);
    });

    it("detects a dead tmux session", () => {
        expect(tmuxSessionExists("spindle-test-nonexistent-session")).toBe(false);
    });

    it("killTmuxSession removes a session", () => {
        const tmp = makeTmpDir();
        createTmuxSession(SESSION, tmp);
        expect(tmuxSessionExists(SESSION)).toBe(true);
        killTmuxSession(SESSION);
        expect(tmuxSessionExists(SESSION)).toBe(false);
    });

    it("killTmuxSession is safe on nonexistent session", () => {
        // Should not throw
        killTmuxSession("spindle-test-nonexistent-session");
    });

    it("isTmuxPaneAlive returns false for dead sessions", () => {
        // A non-existent session should be treated as not alive
        expect(isTmuxPaneAlive("spindle-test-nonexistent-pane")).toBe(false);
    });

    it("isTmuxPaneAlive returns a value for live sessions", () => {
        const tmp = makeTmpDir();
        createTmuxSession(SESSION, tmp);
        // Just verify it returns a boolean without throwing
        const result = isTmuxPaneAlive(SESSION);
        expect(typeof result).toBe("boolean");
        killTmuxSession(SESSION);
    });
});

// ---------------------------------------------------------------------------
// cleanupWorktrees
// ---------------------------------------------------------------------------

describe("cleanupWorktrees", () => {
    let gitDir: string;

    beforeEach(() => {
        gitDir = makeTmpDir();
        initGitRepo(gitDir);
        resetCounter();
    });

    afterEach(() => {
        // Kill any spindle tmux sessions we created
        try {
            const sessions = execSync("tmux list-sessions -F '#{session_name}'", {
                encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            }).trim().split("\n").filter(s => s.startsWith("spindle-test-cleanup-"));
            for (const s of sessions) {
                try { execSync(`tmux kill-session -t ${s}`, { stdio: "pipe" }); } catch {}
            }
        } catch {}
    });

    it("cleans up orphaned worktrees and branches", () => {
        // Create a worktree manually (simulating a crashed subagent)
        const wtDir = path.join(gitDir, ".worktrees", "orphan1");
        fs.mkdirSync(path.join(gitDir, ".worktrees"), { recursive: true });
        execSync(`git worktree add ${JSON.stringify(wtDir)} -b spindle/orphan1`, {
            cwd: gitDir, stdio: "pipe",
        });

        // Verify it exists
        expect(fs.existsSync(wtDir)).toBe(true);
        const branches = execSync("git branch --list 'spindle/*'", {
            cwd: gitDir, encoding: "utf-8",
        }).trim();
        expect(branches).toContain("spindle/orphan1");

        // Cleanup
        const result = cleanupWorktrees(gitDir);
        expect(result.removedWorktrees).toContain("orphan1");
        expect(result.removedBranches).toContain("spindle/orphan1");
        expect(result.errors).toHaveLength(0);

        // Verify gone
        expect(fs.existsSync(wtDir)).toBe(false);
        const branchesAfter = execSync("git branch --list 'spindle/*'", {
            cwd: gitDir, encoding: "utf-8",
        }).trim();
        expect(branchesAfter).not.toContain("spindle/orphan1");
    });

    it("cleans up orphaned tmux sessions", () => {
        const session = "spindle-test-cleanup-orphan";
        createTmuxSession(session, gitDir);
        expect(tmuxSessionExists(session)).toBe(true);

        const result = cleanupWorktrees(gitDir);
        expect(result.removedSessions).toContain(session);
        expect(tmuxSessionExists(session)).toBe(false);
    });

    it("returns empty result when nothing to clean", () => {
        const result = cleanupWorktrees(gitDir);
        expect(result.removedWorktrees).toHaveLength(0);
        expect(result.removedBranches).toHaveLength(0);
        expect(result.removedSessions).toHaveLength(0);
        expect(result.errors).toHaveLength(0);
    });

    it("returns empty result for non-git directory", () => {
        const nonGit = makeTmpDir();
        const result = cleanupWorktrees(nonGit);
        expect(result.removedWorktrees).toHaveLength(0);
    });

    it("handles multiple orphaned worktrees", () => {
        fs.mkdirSync(path.join(gitDir, ".worktrees"), { recursive: true });

        for (const name of ["w0", "w1", "w2"]) {
            const wtDir = path.join(gitDir, ".worktrees", name);
            execSync(`git worktree add ${JSON.stringify(wtDir)} -b spindle/${name}`, {
                cwd: gitDir, stdio: "pipe",
            });
        }

        const result = cleanupWorktrees(gitDir);
        expect(result.removedWorktrees.sort()).toEqual(["w0", "w1", "w2"]);
        expect(result.removedBranches.sort()).toEqual(["spindle/w0", "spindle/w1", "spindle/w2"]);
    });
});

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

describe("poller", () => {
    afterEach(() => {
        stopPoller();
    });

    it("starts and stops cleanly", () => {
        // Note: startPoller calls pollOnce() immediately, which stops
        // the poller if there are no active subagents. So we just test
        // that the start/stop cycle doesn't throw.
        startPoller({
            onUpdate: () => {},
            onDone: () => {},
        });
        // May or may not still be running (depends on whether pollOnce stopped it)
        stopPoller();
        expect(isPollerRunning()).toBe(false);
    });

    it("stops automatically when no active subagents", async () => {
        startPoller({
            onUpdate: () => {},
            onDone: () => {},
        });
        // With no subagents, first poll should stop the poller
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(isPollerRunning()).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Global cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
    killAllSubagents();
    stopPoller();
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
});
