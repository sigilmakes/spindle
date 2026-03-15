import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
    acquireLock,
    releaseLock,
    checkLock,
    withFileLock,
    FileLockError,
} from "../src/locks.js";

describe("FileLock", () => {
    let tmp: string;
    let testFile: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-lock-test-"));
        testFile = path.join(tmp, "target.txt");
        fs.writeFileSync(testFile, "content");
    });

    afterEach(() => {
        // Clean up any leftover locks, then the temp dir
        try { releaseLock(testFile); } catch { /* ignore */ }
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    // -----------------------------------------------------------------------
    // acquireLock
    // -----------------------------------------------------------------------

    it("creates lock dir with metadata", async () => {
        const info = await acquireLock(testFile);

        expect(info.path).toBe(testFile);
        expect(info.pid).toBe(process.pid);
        expect(info.rank).toBe(-1);
        expect(info.timestamp).toBeGreaterThan(0);

        const lockDir = `${testFile}.spindle-lock`;
        expect(fs.existsSync(lockDir)).toBe(true);
        expect(fs.statSync(lockDir).isDirectory()).toBe(true);

        const meta = JSON.parse(fs.readFileSync(path.join(lockDir, "meta.json"), "utf-8"));
        expect(meta.pid).toBe(process.pid);
        expect(meta.rank).toBe(-1);

        releaseLock(testFile);
    });

    it("uses opts.rank when provided", async () => {
        const info = await acquireLock(testFile, { rank: 7 });
        expect(info.rank).toBe(7);
        releaseLock(testFile);
    });

    it("falls back to SPINDLE_RANK env var", async () => {
        const prev = process.env.SPINDLE_RANK;
        try {
            process.env.SPINDLE_RANK = "3";
            const info = await acquireLock(testFile);
            expect(info.rank).toBe(3);
            releaseLock(testFile);
        } finally {
            if (prev === undefined) delete process.env.SPINDLE_RANK;
            else process.env.SPINDLE_RANK = prev;
        }
    });

    it("throws FileLockError when already locked", async () => {
        await acquireLock(testFile, { rank: 2 });

        await expect(acquireLock(testFile)).rejects.toThrow(FileLockError);
        try {
            await acquireLock(testFile);
        } catch (err) {
            expect(err).toBeInstanceOf(FileLockError);
            const lockErr = err as FileLockError;
            expect(lockErr.path).toBe(testFile);
            expect(lockErr.holderRank).toBe(2);
            expect(lockErr.holderPid).toBe(process.pid);
            expect(lockErr.heldForMs).toBeGreaterThanOrEqual(0);
            expect(lockErr.message).toContain("rank 2");
            expect(lockErr.message).toContain(`pid ${process.pid}`);
        }

        releaseLock(testFile);
    });

    it("breaks stale lock (dead PID)", async () => {
        // Simulate a stale lock from a dead process
        const lockDir = `${testFile}.spindle-lock`;
        fs.mkdirSync(lockDir);
        const fakePid = 2147483647; // Very unlikely to be alive
        fs.writeFileSync(
            path.join(lockDir, "meta.json"),
            JSON.stringify({ path: testFile, rank: 5, pid: fakePid, timestamp: Date.now() - 60000 }),
        );

        // Should break the stale lock and acquire
        const info = await acquireLock(testFile, { rank: 1 });
        expect(info.pid).toBe(process.pid);
        expect(info.rank).toBe(1);

        releaseLock(testFile);
    });

    it("retries with timeout", async () => {
        // Lock the file, schedule a release after 150ms
        await acquireLock(testFile);
        setTimeout(() => releaseLock(testFile), 150);

        // Should fail immediately without timeout
        await expect(acquireLock(testFile, { timeout: 0 })).rejects.toThrow(FileLockError);

        // But succeed with a generous timeout (lock released after ~150ms)
        const info = await acquireLock(testFile, { timeout: 2000 });
        expect(info.pid).toBe(process.pid);
        releaseLock(testFile);
    });

    it("concurrent acquireLock from same process (second call fails)", async () => {
        await acquireLock(testFile);
        await expect(acquireLock(testFile)).rejects.toThrow(FileLockError);
        releaseLock(testFile);
    });

    // -----------------------------------------------------------------------
    // releaseLock
    // -----------------------------------------------------------------------

    it("removes lock dir", async () => {
        await acquireLock(testFile);
        const lockDir = `${testFile}.spindle-lock`;
        expect(fs.existsSync(lockDir)).toBe(true);

        releaseLock(testFile);
        expect(fs.existsSync(lockDir)).toBe(false);
    });

    it("is idempotent", () => {
        // Releasing a lock that doesn't exist should not throw
        releaseLock(testFile);
        releaseLock(testFile);
    });

    // -----------------------------------------------------------------------
    // checkLock
    // -----------------------------------------------------------------------

    it("returns info when locked", async () => {
        await acquireLock(testFile, { rank: 4 });

        const info = checkLock(testFile);
        expect(info).not.toBeNull();
        expect(info!.path).toBe(testFile);
        expect(info!.rank).toBe(4);
        expect(info!.pid).toBe(process.pid);

        releaseLock(testFile);
    });

    it("returns null when not locked", () => {
        expect(checkLock(testFile)).toBeNull();
    });

    it("cleans up stale locks and returns null", () => {
        const lockDir = `${testFile}.spindle-lock`;
        fs.mkdirSync(lockDir);
        const fakePid = 2147483647;
        fs.writeFileSync(
            path.join(lockDir, "meta.json"),
            JSON.stringify({ path: testFile, rank: 0, pid: fakePid, timestamp: Date.now() - 30000 }),
        );

        const info = checkLock(testFile);
        expect(info).toBeNull();
        expect(fs.existsSync(lockDir)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // withFileLock
    // -----------------------------------------------------------------------

    it("acquires and releases around fn", async () => {
        let wasLocked = false;
        const result = await withFileLock(testFile, () => {
            wasLocked = checkLock(testFile) !== null;
            return 42;
        });

        expect(result).toBe(42);
        expect(wasLocked).toBe(true);
        expect(checkLock(testFile)).toBeNull();
    });

    it("releases on error", async () => {
        await expect(
            withFileLock(testFile, () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");

        // Lock should be released despite the error
        expect(checkLock(testFile)).toBeNull();
    });

    it("works with async functions", async () => {
        const result = await withFileLock(testFile, async () => {
            await new Promise((r) => setTimeout(r, 10));
            return "async-result";
        });
        expect(result).toBe("async-result");
        expect(checkLock(testFile)).toBeNull();
    });
});
