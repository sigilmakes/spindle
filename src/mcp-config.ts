/**
 * MCP configuration loading and merging.
 *
 * Config layering (highest priority wins):
 *   1. .pi/mcp.json              (project-local)
 *   2. ~/.pi/agent/mcp.json      (global pi config)
 *   3. Editor imports             (Cursor, Claude Desktop, VS Code, etc.)
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// --- Types ---

export interface McpServerEntry {
    /** Stdio: command to run */
    command?: string;
    /** Stdio: command arguments */
    args?: string[];
    /** Stdio: environment variables (supports ${VAR} interpolation) */
    env?: Record<string, string>;
    /** Stdio: working directory */
    cwd?: string;
    /** HTTP: endpoint URL */
    url?: string;
    /** HTTP: custom headers (supports ${VAR} interpolation) */
    headers?: Record<string, string>;
    /** Human-readable description for prompt injection */
    description?: string;
    /** Idle timeout in minutes (default: 10, 0 to disable) */
    idleTimeout?: number;
}

export interface McpConfig {
    mcpServers: Record<string, McpServerEntry>;
    imports?: string[];
}

export interface ResolvedServer {
    name: string;
    entry: McpServerEntry;
    source: "project" | "global" | "import";
}

// --- Editor config paths ---

const EDITOR_CONFIG_PATHS: Record<string, () => string[]> = {
    "cursor": () => {
        const h = homedir();
        return [
            join(h, ".cursor", "mcp.json"),
        ];
    },
    "claude-code": () => {
        const h = homedir();
        return [
            join(h, ".claude", "claude_desktop_config.json"),
            join(h, ".claude.json"),
        ];
    },
    "claude-desktop": () => {
        const h = homedir();
        const platform = process.platform;
        if (platform === "darwin") {
            return [join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json")];
        } else if (platform === "win32") {
            return [join(process.env.APPDATA || join(h, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")];
        }
        return [join(h, ".config", "claude", "claude_desktop_config.json")];
    },
    "vscode": () => {
        const h = homedir();
        const platform = process.platform;
        if (platform === "darwin") {
            return [join(h, "Library", "Application Support", "Code", "User", "settings.json")];
        } else if (platform === "win32") {
            return [join(process.env.APPDATA || join(h, "AppData", "Roaming"), "Code", "User", "settings.json")];
        }
        return [join(h, ".config", "Code", "User", "settings.json")];
    },
    "windsurf": () => {
        const h = homedir();
        return [join(h, ".codeium", "windsurf", "mcp_config.json")];
    },
    "codex": () => {
        const h = homedir();
        return [join(h, ".codex", "mcp.json")];
    },
};

// --- Config loading ---

function readJsonSafe(path: string): unknown {
    try {
        if (!existsSync(path)) return null;
        const raw = readFileSync(path, "utf-8");
        // Strip JSONC comments (// and /* */ single-line only)
        const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*.*?\*\//g, "");
        return JSON.parse(stripped);
    } catch {
        return null;
    }
}

function extractServers(data: unknown): Record<string, McpServerEntry> {
    if (!data || typeof data !== "object") return {};

    const obj = data as Record<string, unknown>;

    // Direct mcpServers field
    if (obj.mcpServers && typeof obj.mcpServers === "object") {
        return obj.mcpServers as Record<string, McpServerEntry>;
    }

    // VS Code style: mcp.servers within settings.json
    if (obj["mcp.servers"] && typeof obj["mcp.servers"] === "object") {
        return obj["mcp.servers"] as Record<string, McpServerEntry>;
    }

    // VS Code nested style: mcp.mcpServers
    const mcp = obj.mcp as Record<string, unknown> | undefined;
    if (mcp?.mcpServers && typeof mcp.mcpServers === "object") {
        return mcp.mcpServers as Record<string, McpServerEntry>;
    }
    if (mcp?.servers && typeof mcp.servers === "object") {
        return mcp.servers as Record<string, McpServerEntry>;
    }

    return {};
}

function loadEditorServers(importName: string): Record<string, McpServerEntry> {
    const pathsFn = EDITOR_CONFIG_PATHS[importName];
    if (!pathsFn) return {};

    for (const p of pathsFn()) {
        const data = readJsonSafe(p);
        const servers = extractServers(data);
        if (Object.keys(servers).length > 0) return servers;
    }
    return {};
}

/**
 * Load and merge MCP configuration from all layers.
 *
 * @param cwd - Project working directory (for .pi/mcp.json)
 * @returns Merged config with source tracking
 */
export function loadMcpConfig(cwd: string): {
    servers: Map<string, ResolvedServer>;
    raw: McpConfig;
} {
    const servers = new Map<string, ResolvedServer>();

    // Layer 3 (lowest priority): Editor imports
    // Determine which imports to use from the highest-priority config that specifies them
    let imports: string[] | undefined;

    const projectPath = join(cwd, ".pi", "mcp.json");
    const globalPath = join(homedir(), ".pi", "agent", "mcp.json");

    const projectData = readJsonSafe(projectPath) as McpConfig | null;
    const globalData = readJsonSafe(globalPath) as McpConfig | null;

    imports = projectData?.imports ?? globalData?.imports;

    // Default imports if none specified
    if (!imports) {
        imports = ["cursor", "claude-code", "claude-desktop", "windsurf", "codex", "vscode"];
    }

    for (const importName of imports) {
        const editorServers = loadEditorServers(importName);
        for (const [name, entry] of Object.entries(editorServers)) {
            if (!servers.has(name)) {
                servers.set(name, { name, entry, source: "import" });
            }
        }
    }

    // Layer 2: Global config (~/.pi/agent/mcp.json)
    if (globalData?.mcpServers) {
        for (const [name, entry] of Object.entries(globalData.mcpServers)) {
            servers.set(name, { name, entry, source: "global" });
        }
    }

    // Layer 1 (highest priority): Project config (.pi/mcp.json)
    if (projectData?.mcpServers) {
        for (const [name, entry] of Object.entries(projectData.mcpServers)) {
            servers.set(name, { name, entry, source: "project" });
        }
    }

    // Build merged raw config
    const mergedServers: Record<string, McpServerEntry> = {};
    for (const [name, resolved] of servers) {
        mergedServers[name] = resolved.entry;
    }

    return {
        servers,
        raw: { mcpServers: mergedServers, imports },
    };
}

/**
 * Build a prompt summary of available MCP servers from config descriptions.
 * Only includes servers that have a description field.
 */
export function buildServerPromptSummary(servers: Map<string, ResolvedServer>): string | null {
    if (servers.size === 0) return null;

    const described: string[] = [];
    let undescribedCount = 0;

    for (const [name, resolved] of servers) {
        if (resolved.entry.description) {
            described.push(`  ${name} — ${resolved.entry.description}`);
        } else {
            undescribedCount++;
        }
    }

    if (described.length === 0 && undescribedCount === 0) return null;

    const lines: string[] = [
        "MCP servers (use spindle's mcp/mcp_call/mcp_connect builtins):",
    ];
    lines.push(...described);
    if (undescribedCount > 0) {
        lines.push(`  [${undescribedCount} more without descriptions — use mcp() to discover]`);
    }
    lines.push("Use mcp(\"server\") to see available tools before calling.");

    return lines.join("\n");
}

/**
 * Interpolate ${VAR} placeholders in a string using process.env.
 */
export function interpolateEnv(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
        // Support ${VAR:-default} syntax
        const [name, defaultValue] = varName.split(":-");
        return process.env[name.trim()] ?? defaultValue?.trim() ?? "";
    });
}

/**
 * Resolve environment variables for a server entry.
 */
export function resolveServerEnv(entry: McpServerEntry): Record<string, string> | undefined {
    if (!entry.env) return undefined;
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.env)) {
        resolved[key] = interpolateEnv(value);
    }
    return resolved;
}

/**
 * Resolve headers for a server entry.
 */
export function resolveServerHeaders(entry: McpServerEntry): Record<string, string> | undefined {
    if (!entry.headers) return undefined;
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.headers)) {
        resolved[key] = interpolateEnv(value);
    }
    return resolved;
}
