import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Lock notification callback — set by the extension to broadcast via comm
// ---------------------------------------------------------------------------

let lockNotifier: ((event: "lock" | "unlock", filePath: string) => void) | null = null;

/** Register a callback that fires on lock acquire/release (e.g. to broadcast via comm). */
export function setLockNotifier(fn: typeof lockNotifier): void {
    lockNotifier = fn;
}

// ---------------------------------------------------------------------------
// Held lock tracking — for cleanup on process exit
// ---------------------------------------------------------------------------

const heldLocks = new Set<string>();

/** Clean up any locks held by this process. Called on exit. */
export function releaseAllLocks(): void {
    for (const filePath of heldLocks) {
        try { removeLockDir(filePath); } catch { /* best effort */ }
    }
    heldLocks.clear();
}

// Register cleanup on normal exit (SIGTERM/SIGINT handled by Node's default behavior
// which calls 'exit' after the signal handler)
process.on("exit", releaseAllLocks);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Default timeout (ms) for lock acquisition in tool wrappers. */
export const DEFAULT_LOCK_TIMEOUT = 10_000;

export interface LockInfo {
    path: string;
    rank: number;
    pid: number;
    timestamp: number;
}

export class FileLockError extends Error {
    readonly path: string;
    readonly holderRank: number;
    readonly holderPid: number;
    readonly heldForMs: number;

    constructor(filePath: string, holderRank: number, holderPid: number, heldForMs: number) {
        super(
            `File locked by rank ${holderRank} (pid ${holderPid}, held for ${(heldForMs / 1000).toFixed(1)}s): ${filePath}`,
        );
        this.name = "FileLockError";
        this.path = filePath;
        this.holderRank = holderRank;
        this.holderPid = holderPid;
        this.heldForMs = heldForMs;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lockDir(filePath: string): string {
    return `${filePath}.spindle-lock`;
}

function metadataFile(filePath: string): string {
    return path.join(lockDir(filePath), "meta.json");
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function readMetadata(filePath: string): LockInfo | null {
    try {
        const raw = fs.readFileSync(metadataFile(filePath), "utf-8");
        return JSON.parse(raw) as LockInfo;
    } catch {
        return null;
    }
}

function removeLockDir(filePath: string): void {
    const dir = lockDir(filePath);
    try {
        // Remove metadata file first, then the directory
        const meta = metadataFile(filePath);
        try { fs.unlinkSync(meta); } catch { /* already gone */ }
        fs.rmdirSync(dir);
    } catch {
        // Already cleaned up — that's fine
    }
}

function resolveRank(opts?: { rank?: number }): number {
    if (opts?.rank !== undefined) return opts.rank;
    const envRank = process.env.SPINDLE_RANK;
    if (envRank !== undefined) return parseInt(envRank, 10);
    return -1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function acquireLockSync(filePath: string, opts?: { rank?: number }): LockInfo {
    const dir = lockDir(filePath);
    const rank = resolveRank(opts);

    try {
        fs.mkdirSync(dir);
    } catch (err: any) {
        if (err.code !== "EEXIST") throw err;

        // Lock dir exists — check if it's stale
        const existing = readMetadata(filePath);
        if (existing && !isPidAlive(existing.pid)) {
            // Stale lock — break it and retry
            removeLockDir(filePath);
            fs.mkdirSync(dir);
        } else if (existing) {
            throw new FileLockError(
                filePath,
                existing.rank,
                existing.pid,
                Date.now() - existing.timestamp,
            );
        } else {
            // Dir exists but no metadata — treat as stale
            removeLockDir(filePath);
            fs.mkdirSync(dir);
        }
    }

    const info: LockInfo = { path: filePath, rank, pid: process.pid, timestamp: Date.now() };
    fs.writeFileSync(metadataFile(filePath), JSON.stringify(info), "utf-8");
    heldLocks.add(filePath);
    lockNotifier?.("lock", filePath);
    return info;
}

export async function acquireLock(
    filePath: string,
    opts?: { rank?: number; timeout?: number },
): Promise<LockInfo> {
    const timeout = opts?.timeout ?? 0;
    const deadline = Date.now() + timeout;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            return acquireLockSync(filePath, opts);
        } catch (err) {
            if (!(err instanceof FileLockError)) throw err;
            if (timeout <= 0 || Date.now() >= deadline) throw err;
            // Backoff and retry
            const remaining = deadline - Date.now();
            const delay = Math.min(100, remaining);
            if (delay <= 0) throw err;
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

export function releaseLock(filePath: string): void {
    removeLockDir(filePath);
    heldLocks.delete(filePath);
    lockNotifier?.("unlock", filePath);
}

export function checkLock(filePath: string): LockInfo | null {
    const info = readMetadata(filePath);
    if (!info) return null;

    if (!isPidAlive(info.pid)) {
        // Stale lock — clean up
        removeLockDir(filePath);
        return null;
    }

    return info;
}

export async function withFileLock<T>(
    filePath: string,
    fn: () => T | Promise<T>,
    opts?: { rank?: number; timeout?: number },
): Promise<T> {
    await acquireLock(filePath, opts);
    try {
        return await fn();
    } finally {
        releaseLock(filePath);
    }
}
