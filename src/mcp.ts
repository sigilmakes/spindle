/**
 * MCP integration for Spindle via mcporter.
 *
 * Exposes three REPL builtins:
 *   mcp(server?)        — list servers or tools for a specific server
 *   mcp_call(server, tool, args) — one-shot tool call
 *   mcp_connect(server) — returns a persistent ServerProxy
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { ToolResult } from "./tools.js";

// Lazy imports — mcporter is heavy, don't load until first use
let _createRuntime: typeof import("mcporter").createRuntime | null = null;
let _createServerProxy: typeof import("mcporter").createServerProxy | null = null;
let _callOnce: typeof import("mcporter").callOnce | null = null;

async function loadMcporter() {
    if (!_createRuntime) {
        const mod = await import("mcporter");
        _createRuntime = mod.createRuntime;
        _createServerProxy = mod.createServerProxy;
        _callOnce = mod.callOnce;
    }
    return { createRuntime: _createRuntime!, createServerProxy: _createServerProxy!, callOnce: _callOnce! };
}

// Singleton runtime — created on first use, reused for connection pooling
let _runtime: Awaited<ReturnType<typeof import("mcporter").createRuntime>> | null = null;

function resolveConfigPath(): string | undefined {
    const piConfig = join(homedir(), ".pi", "agent", "mcp.json");
    if (existsSync(piConfig)) return piConfig;
    return undefined;
}

async function getRuntime() {
    if (!_runtime) {
        const { createRuntime } = await loadMcporter();
        _runtime = await createRuntime({
            configPath: resolveConfigPath(),
        });
    }
    return _runtime;
}

// Track connected proxies for cleanup
const _proxies = new Map<string, unknown>();

/**
 * mcp(server?) — Discovery builtin.
 *   mcp()           → list all server names with status
 *   mcp("linear")   → list tools for a specific server
 *   mcp("linear", { schema: true }) → include parameter schemas
 */
export async function mcpList(
    server?: string,
    opts?: { schema?: boolean },
): Promise<ToolResult> {
    try {
        const runtime = await getRuntime();

        if (!server) {
            // List all servers
            const servers = runtime.listServers();
            if (servers.length === 0) {
                return ToolResult.success("No MCP servers configured.\nConfig: ~/.pi/agent/mcp.json");
            }
            return ToolResult.success(
                `MCP servers (${servers.length}):\n` +
                servers.map(s => `  ${s}`).join("\n")
            );
        }

        // List tools for a specific server
        const tools = await runtime.listTools(server, {
            includeSchema: opts?.schema ?? false,
        });

        if (tools.length === 0) {
            return ToolResult.success(`Server "${server}" has no tools.`);
        }

        const lines = tools.map(t => {
            let line = `  ${t.name}`;
            if (t.description) {
                const desc = t.description.length > 80
                    ? t.description.slice(0, 80) + "..."
                    : t.description;
                line += ` — ${desc}`;
            }
            if (opts?.schema && t.inputSchema) {
                line += `\n    Schema: ${JSON.stringify(t.inputSchema)}`;
            }
            return line;
        });

        return ToolResult.success(
            `${server} (${tools.length} tools):\n` + lines.join("\n")
        );
    } catch (err: any) {
        return ToolResult.fail(err.message || String(err));
    }
}

/**
 * mcp_call(server, tool, args?) — One-shot tool call.
 * Uses the shared pooled runtime so repeated calls reuse connections.
 */
export async function mcpCall(
    server: string,
    toolName: string,
    args?: Record<string, unknown>,
): Promise<ToolResult> {
    try {
        const runtime = await getRuntime();
        const result = await runtime.callTool(server, toolName, { args });

        // Extract text from MCP result, check for MCP-level errors
        const text = extractResultText(result);
        if (typeof result === "object" && result !== null && (result as any).isError) {
            return ToolResult.fail(text);
        }
        return ToolResult.success(text);
    } catch (err: any) {
        return ToolResult.fail(err.message || String(err));
    }
}

/**
 * mcp_connect(server) — Returns a persistent ServerProxy.
 * The proxy lives in REPL state and reuses the pooled runtime connection.
 * Methods are camelCase, schema-validated, return CallResult with .text()/.json()/.markdown().
 *
 * Unlike other MCP builtins, this throws on error (not ToolResult) because
 * the return value is a proxy object the caller stores in a variable.
 */
export async function mcpConnect(server: string): Promise<unknown> {
    const { createServerProxy } = await loadMcporter();
    const runtime = await getRuntime();

    // Verify server exists — throws with clear message if not found
    try {
        runtime.getDefinition(server);
    } catch {
        const available = runtime.listServers();
        throw new Error(
            `Unknown MCP server "${server}".` +
            (available.length > 0 ? ` Available: ${available.join(", ")}` : " No servers configured.")
        );
    }

    const proxy = createServerProxy(runtime, server);
    _proxies.set(server, proxy);
    return proxy;
}

/**
 * mcp_disconnect(server?) — Close connections.
 *   mcp_disconnect()        → close all
 *   mcp_disconnect("linear") → close specific server
 */
export async function mcpDisconnect(server?: string): Promise<ToolResult> {
    try {
        if (_runtime) {
            if (server) {
                await _runtime.close(server);
            } else {
                await _runtime.close();
                _runtime = null; // Force fresh runtime on next use
            }
        }
        if (server) {
            _proxies.delete(server);
        } else {
            _proxies.clear();
        }
        return ToolResult.success(server ? `Disconnected from "${server}".` : "Disconnected all MCP servers.");
    } catch (err: any) {
        return ToolResult.fail(err.message || String(err));
    }
}

/**
 * Cleanup all MCP connections. Called on session shutdown.
 */
export async function mcpCleanup(): Promise<void> {
    if (_runtime) {
        try {
            await _runtime.close();
        } catch { /* best effort */ }
        _runtime = null;
    }
    _proxies.clear();
    _createRuntime = null;
    _createServerProxy = null;
    _callOnce = null;
}

/**
 * Extract readable text from an MCP call result.
 */
function extractResultText(result: unknown): string {
    if (result === null || result === undefined) return "(empty result)";
    if (typeof result === "string") return result;

    // MCP results often have a content array
    if (typeof result === "object" && "content" in (result as any)) {
        const content = (result as any).content;
        if (Array.isArray(content)) {
            return content
                .map((c: any) => {
                    if (c.type === "text" && c.text) return c.text;
                    if (c.type === "image") return `[Image: ${c.mimeType ?? "unknown"}]`;
                    return JSON.stringify(c);
                })
                .join("\n");
        }
    }

    return JSON.stringify(result, null, 2);
}
