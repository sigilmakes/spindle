/**
 * Metadata cache for MCP tool schemas.
 *
 * Persists tool metadata to disk so mcp() and mcp("server") can
 * return results without establishing a live connection.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface CachedToolInfo {
    name: string;
    description?: string;
    inputSchema?: unknown;
}

export interface CachedServerMeta {
    tools: CachedToolInfo[];
    cachedAt: string;
    serverVersion?: string;
}

export type CacheData = Record<string, CachedServerMeta>;

const CACHE_PATH = join(homedir(), ".pi", "agent", "mcp-cache.json");

let _cache: CacheData | null = null;

function ensureCacheDir(): void {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
}

function loadCache(): CacheData {
    if (_cache) return _cache;
    try {
        const raw = readFileSync(CACHE_PATH, "utf-8");
        _cache = JSON.parse(raw) as CacheData;
    } catch {
        _cache = {};
    }
    return _cache;
}

function saveCache(): void {
    if (!_cache) return;
    try {
        ensureCacheDir();
        writeFileSync(CACHE_PATH, JSON.stringify(_cache, null, 2), "utf-8");
    } catch {
        // Best effort
    }
}

/**
 * Get cached tool metadata for a server.
 */
export function getCachedTools(serverName: string): CachedToolInfo[] | null {
    const cache = loadCache();
    return cache[serverName]?.tools ?? null;
}

/**
 * Update the cache for a server after a successful listTools call.
 */
export function updateCache(
    serverName: string,
    tools: CachedToolInfo[],
    serverVersion?: string,
): void {
    const cache = loadCache();
    cache[serverName] = {
        tools,
        cachedAt: new Date().toISOString(),
        serverVersion,
    };
    saveCache();
}

/**
 * Remove a server from the cache.
 */
export function removeCached(serverName: string): void {
    const cache = loadCache();
    delete cache[serverName];
    saveCache();
}

/**
 * Clear the entire cache.
 */
export function clearCache(): void {
    _cache = {};
    saveCache();
}

/**
 * Reset in-memory cache (for testing or reload).
 */
export function resetCacheMemory(): void {
    _cache = null;
}
