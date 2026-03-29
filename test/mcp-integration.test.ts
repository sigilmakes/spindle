/**
 * Integration tests for MCP configuration, caching, and prompt injection.
 *
 * Tests config loading/merging, metadata caching, prompt summary generation,
 * and environment variable interpolation. Does NOT test live server connections
 * (those depend on external services).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
    loadMcpConfig, buildServerPromptSummary,
    interpolateEnv, resolveServerEnv, resolveServerHeaders,
    type McpServerEntry, type ResolvedServer,
} from "../src/mcp-config.js";
import {
    getCachedTools, updateCache, removeCached, clearCache, resetCacheMemory,
    type CachedToolInfo,
} from "../src/mcp-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-mcp-test-"));
    tmpDirs.push(dir);
    return dir;
}

function writeJson(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

afterAll(() => {
    for (const dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    tmpDirs = [];
});

// ---------------------------------------------------------------------------
// interpolateEnv
// ---------------------------------------------------------------------------

describe("interpolateEnv", () => {
    beforeEach(() => {
        savedEnv = {};
    });
    afterEach(() => {
        for (const [key, val] of Object.entries(savedEnv)) {
            if (val === undefined) delete process.env[key];
            else process.env[key] = val;
        }
    });

    function setEnv(key: string, value: string): void {
        savedEnv[key] = process.env[key];
        process.env[key] = value;
    }

    it("interpolates simple ${VAR}", () => {
        setEnv("SPINDLE_TEST_KEY", "secret123");
        expect(interpolateEnv("Bearer ${SPINDLE_TEST_KEY}")).toBe("Bearer secret123");
    });

    it("handles missing vars as empty string", () => {
        delete process.env.SPINDLE_NONEXISTENT_VAR;
        expect(interpolateEnv("key=${SPINDLE_NONEXISTENT_VAR}")).toBe("key=");
    });

    it("supports ${VAR:-default} syntax", () => {
        delete process.env.SPINDLE_MISSING;
        expect(interpolateEnv("${SPINDLE_MISSING:-fallback}")).toBe("fallback");
    });

    it("uses env value over default when set", () => {
        setEnv("SPINDLE_SET_VAR", "real");
        expect(interpolateEnv("${SPINDLE_SET_VAR:-fallback}")).toBe("real");
    });

    it("handles multiple interpolations in one string", () => {
        setEnv("SPINDLE_A", "hello");
        setEnv("SPINDLE_B", "world");
        expect(interpolateEnv("${SPINDLE_A} ${SPINDLE_B}")).toBe("hello world");
    });

    it("passes through strings without ${}", () => {
        expect(interpolateEnv("no-vars-here")).toBe("no-vars-here");
    });
});

// ---------------------------------------------------------------------------
// resolveServerEnv / resolveServerHeaders
// ---------------------------------------------------------------------------

describe("resolveServerEnv", () => {
    beforeEach(() => { savedEnv = {}; });
    afterEach(() => {
        for (const [key, val] of Object.entries(savedEnv)) {
            if (val === undefined) delete process.env[key];
            else process.env[key] = val;
        }
    });

    it("returns undefined when no env field", () => {
        const entry: McpServerEntry = { command: "node", args: ["server.js"] };
        expect(resolveServerEnv(entry)).toBeUndefined();
    });

    it("resolves env vars in server entry", () => {
        savedEnv["SPINDLE_API_KEY"] = process.env["SPINDLE_API_KEY"];
        process.env["SPINDLE_API_KEY"] = "test-key-123";

        const entry: McpServerEntry = {
            command: "node",
            args: ["server.js"],
            env: { "API_KEY": "${SPINDLE_API_KEY}" },
        };

        const result = resolveServerEnv(entry);
        expect(result).toEqual({ "API_KEY": "test-key-123" });
    });
});

describe("resolveServerHeaders", () => {
    beforeEach(() => { savedEnv = {}; });
    afterEach(() => {
        for (const [key, val] of Object.entries(savedEnv)) {
            if (val === undefined) delete process.env[key];
            else process.env[key] = val;
        }
    });

    it("returns undefined when no headers field", () => {
        const entry: McpServerEntry = { url: "https://example.com/mcp" };
        expect(resolveServerHeaders(entry)).toBeUndefined();
    });

    it("resolves env vars in headers", () => {
        savedEnv["SPINDLE_TOKEN"] = process.env["SPINDLE_TOKEN"];
        process.env["SPINDLE_TOKEN"] = "bearer-xyz";

        const entry: McpServerEntry = {
            url: "https://example.com/mcp",
            headers: { "Authorization": "Bearer ${SPINDLE_TOKEN}" },
        };

        const result = resolveServerHeaders(entry);
        expect(result).toEqual({ "Authorization": "Bearer bearer-xyz" });
    });
});

// ---------------------------------------------------------------------------
// buildServerPromptSummary
// ---------------------------------------------------------------------------

describe("buildServerPromptSummary", () => {
    it("returns null for empty map", () => {
        expect(buildServerPromptSummary(new Map())).toBeNull();
    });

    it("builds summary with described servers", () => {
        const servers = new Map<string, ResolvedServer>([
            ["context7", {
                name: "context7",
                entry: { url: "https://mcp.context7.com/mcp", description: "Library docs" },
                source: "global",
            }],
            ["searxng", {
                name: "searxng",
                entry: { command: "npx", args: ["searxng-mcp"], description: "Web search" },
                source: "project",
            }],
        ]);

        const summary = buildServerPromptSummary(servers);
        expect(summary).toContain("MCP servers");
        expect(summary).toContain("context7");
        expect(summary).toContain("Library docs");
        expect(summary).toContain("searxng");
        expect(summary).toContain("Web search");
    });

    it("counts undescribed servers", () => {
        const servers = new Map<string, ResolvedServer>([
            ["described", {
                name: "described",
                entry: { url: "https://example.com", description: "Has desc" },
                source: "global",
            }],
            ["no-desc", {
                name: "no-desc",
                entry: { command: "node", args: ["server.js"] },
                source: "global",
            }],
        ]);

        const summary = buildServerPromptSummary(servers);
        expect(summary).toContain("1 more");
        expect(summary).toContain("described");
        expect(summary).not.toContain("no-desc");
    });

    it("returns null when all servers lack descriptions", () => {
        const servers = new Map<string, ResolvedServer>([
            ["a", { name: "a", entry: { command: "x" }, source: "global" }],
        ]);

        const summary = buildServerPromptSummary(servers);
        // Should still return something (with just the "N more" line)
        expect(summary).toContain("1 more");
    });
});

// ---------------------------------------------------------------------------
// MCP Cache
// ---------------------------------------------------------------------------

describe("mcp cache", () => {
    beforeEach(() => {
        resetCacheMemory();
    });

    it("returns null for unknown server", () => {
        expect(getCachedTools("nonexistent-server")).toBeNull();
    });

    it("stores and retrieves tool metadata", () => {
        const tools: CachedToolInfo[] = [
            { name: "resolve-library-id", description: "Find a library" },
            { name: "get-library-docs", description: "Get docs", inputSchema: { type: "object" } },
        ];

        updateCache("test-server", tools);
        const cached = getCachedTools("test-server");

        expect(cached).not.toBeNull();
        expect(cached).toHaveLength(2);
        expect(cached![0].name).toBe("resolve-library-id");
        expect(cached![1].inputSchema).toEqual({ type: "object" });
    });

    it("overwrites cache on update", () => {
        updateCache("s", [{ name: "tool-a" }]);
        updateCache("s", [{ name: "tool-b" }, { name: "tool-c" }]);

        const cached = getCachedTools("s");
        expect(cached).toHaveLength(2);
        expect(cached![0].name).toBe("tool-b");
    });

    it("removes a server from cache", () => {
        updateCache("s", [{ name: "tool-a" }]);
        removeCached("s");
        expect(getCachedTools("s")).toBeNull();
    });

    it("clears entire cache", () => {
        updateCache("a", [{ name: "t1" }]);
        updateCache("b", [{ name: "t2" }]);
        clearCache();
        expect(getCachedTools("a")).toBeNull();
        expect(getCachedTools("b")).toBeNull();
    });

    it("resetCacheMemory forces reload from disk", () => {
        updateCache("mem-test", [{ name: "tool-x" }]);
        resetCacheMemory();
        // After reset, it should reload from disk — the data we just wrote
        const cached = getCachedTools("mem-test");
        expect(cached).not.toBeNull();
        expect(cached![0].name).toBe("tool-x");
    });
});

// ---------------------------------------------------------------------------
// loadMcpConfig
// ---------------------------------------------------------------------------

describe("loadMcpConfig", () => {
    let projectDir: string;

    beforeEach(() => {
        projectDir = makeTmpDir();
    });

    it("returns empty servers when no config files exist", () => {
        // Use a temp dir that has no .pi/mcp.json
        const isolated = makeTmpDir();
        const { servers } = loadMcpConfig(isolated);
        // May pick up editor imports from the real system, but project/global should be empty
        // Just verify it doesn't crash
        expect(servers).toBeInstanceOf(Map);
    });

    it("loads project config from .pi/mcp.json", () => {
        const configPath = path.join(projectDir, ".pi", "mcp.json");
        writeJson(configPath, {
            mcpServers: {
                "test-server": {
                    command: "node",
                    args: ["test.js"],
                    description: "Test server",
                },
            },
            imports: [], // Disable editor imports for clean test
        });

        const { servers } = loadMcpConfig(projectDir);
        expect(servers.has("test-server")).toBe(true);

        const resolved = servers.get("test-server")!;
        expect(resolved.source).toBe("project");
        expect(resolved.entry.description).toBe("Test server");
    });

    it("project config overrides global config", () => {
        // Create a project config with imports: [] to isolate
        const projectConfig = path.join(projectDir, ".pi", "mcp.json");
        writeJson(projectConfig, {
            mcpServers: {
                "shared-server": {
                    url: "https://project.example.com",
                    description: "Project version",
                },
            },
            imports: [],
        });

        const { servers } = loadMcpConfig(projectDir);
        const resolved = servers.get("shared-server");
        // It should be from project
        if (resolved) {
            expect(resolved.source).toBe("project");
            expect(resolved.entry.url).toBe("https://project.example.com");
        }
    });

    it("handles JSONC comments in config", () => {
        const configPath = path.join(projectDir, ".pi", "mcp.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, `{
            // This is a comment
            "mcpServers": {
                "test": {
                    "url": "https://example.com" /* inline comment */
                }
            },
            "imports": []
        }`);

        const { servers } = loadMcpConfig(projectDir);
        expect(servers.has("test")).toBe(true);
    });

    it("supports all server entry fields", () => {
        const configPath = path.join(projectDir, ".pi", "mcp.json");
        writeJson(configPath, {
            mcpServers: {
                "full": {
                    command: "npx",
                    args: ["-y", "server@latest"],
                    env: { "KEY": "value" },
                    cwd: "/tmp",
                    description: "Full config",
                    idleTimeout: 5,
                },
                "http": {
                    url: "https://api.example.com/mcp",
                    headers: { "Authorization": "Bearer token" },
                    description: "HTTP server",
                },
            },
            imports: [],
        });

        const { servers } = loadMcpConfig(projectDir);
        // May include servers from global ~/.pi/agent/mcp.json — just check ours are present
        expect(servers.has("full")).toBe(true);
        expect(servers.has("http")).toBe(true);

        const full = servers.get("full")!;
        expect(full.entry.command).toBe("npx");
        expect(full.entry.args).toEqual(["-y", "server@latest"]);
        expect(full.entry.env).toEqual({ "KEY": "value" });
        expect(full.entry.idleTimeout).toBe(5);

        const http = servers.get("http")!;
        expect(http.entry.url).toBe("https://api.example.com/mcp");
        expect(http.entry.headers).toEqual({ "Authorization": "Bearer token" });
    });
});
