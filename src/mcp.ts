/**
 * MCP integration for Spindle — built on @modelcontextprotocol/sdk.
 *
 * Features:
 *   - Full MCP protocol (tools, sampling, elicitation, roots)
 *   - Lazy connections with idle timeout
 *   - Metadata caching (tool discovery without live connections)
 *   - Config layering (project > global > editor imports)
 *
 * REPL builtins:
 *   mcp(server?)               — list servers or tools
 *   mcp_call(server, tool, args) — one-shot tool call
 *   mcp_connect(server)        — persistent connection handle
 *   mcp_disconnect(server?)    — close connections
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

import { ToolResult } from "./tools.js";
import {
    loadMcpConfig, buildServerPromptSummary,
    interpolateEnv, resolveServerEnv, resolveServerHeaders,
    type McpServerEntry, type ResolvedServer,
} from "./mcp-config.js";
import {
    getCachedTools, updateCache, removeCached,
    resetCacheMemory, type CachedToolInfo,
} from "./mcp-cache.js";

// --- Types ---

interface ManagedConnection {
    client: Client;
    transport: Transport;
    serverName: string;
    status: "connecting" | "connected" | "closed";
    lastUsedAt: number;
    idleTimer?: ReturnType<typeof setTimeout>;
}

interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: unknown;
}

// --- Callbacks for server→client requests ---

export interface McpHandlers {
    /** Handle sampling/createMessage requests from servers */
    onSampling?: (params: {
        messages: unknown[];
        systemPrompt?: string;
        maxTokens: number;
        temperature?: number;
        modelPreferences?: unknown;
    }) => Promise<{
        model: string;
        role: "assistant";
        content: { type: "text"; text: string };
        stopReason?: string;
    }>;

    /** Handle elicitation/create requests from servers */
    onElicitation?: (params: {
        message: string;
        requestedSchema?: unknown;
    }) => Promise<{
        action: "accept" | "decline" | "cancel";
        content?: Record<string, unknown>;
    }>;

    /** Handle roots/list requests from servers */
    onRoots?: () => Promise<{
        roots: Array<{ uri: string; name?: string }>;
    }>;
}

// --- State ---

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const CONNECT_TIMEOUT_MS = 30_000;

let _connections = new Map<string, ManagedConnection>();
let _connectPromises = new Map<string, Promise<ManagedConnection>>();
let _servers = new Map<string, ResolvedServer>();
let _cwd = process.cwd();
let _handlers: McpHandlers = {};
let _initialized = false;

// --- Init ---

/**
 * Initialize (or reinitialize) the MCP subsystem.
 * Reads config, does NOT connect to anything.
 */
export function mcpInit(cwd: string, handlers?: McpHandlers): void {
    _cwd = cwd;
    if (handlers) _handlers = handlers;
    const { servers } = loadMcpConfig(cwd);
    _servers = servers;
    _initialized = true;
}

/**
 * Get the current server map (for prompt injection).
 */
export function mcpGetServers(): Map<string, ResolvedServer> {
    if (!_initialized) mcpInit(_cwd);
    return _servers;
}

/**
 * Build the prompt summary string.
 */
export function mcpGetPromptSummary(): string | null {
    return buildServerPromptSummary(mcpGetServers());
}

/**
 * Reload config (e.g. after editing mcp.json).
 */
export async function mcpReload(cwd?: string): Promise<void> {
    if (cwd) _cwd = cwd;
    // Disconnect all before reloading
    await mcpCleanup();
    resetCacheMemory();
    const { servers } = loadMcpConfig(_cwd);
    _servers = servers;
    _initialized = true;
}

// --- Connection management ---

function getIdleTimeout(entry: McpServerEntry): number {
    if (entry.idleTimeout === 0) return 0; // Disabled
    return (entry.idleTimeout ?? 10) * 60 * 1000;
}

function touchConnection(conn: ManagedConnection): void {
    conn.lastUsedAt = Date.now();

    // Reset idle timer
    if (conn.idleTimer) clearTimeout(conn.idleTimer);

    const resolved = _servers.get(conn.serverName);
    const timeout = resolved ? getIdleTimeout(resolved.entry) : DEFAULT_IDLE_TIMEOUT_MS;

    if (timeout > 0) {
        conn.idleTimer = setTimeout(async () => {
            await disconnectServer(conn.serverName);
        }, timeout);
    }
}

function buildCapabilities(): ClientCapabilities {
    const caps: ClientCapabilities = {};

    if (_handlers.onSampling) {
        caps.sampling = {};
    }
    if (_handlers.onElicitation) {
        caps.elicitation = {};
    }
    if (_handlers.onRoots) {
        caps.roots = { listChanged: false };
    }

    return caps;
}

async function createTransport(entry: McpServerEntry): Promise<Transport> {
    if (entry.command) {
        // Stdio transport
        return new StdioClientTransport({
            command: entry.command,
            args: entry.args,
            env: resolveServerEnv(entry) ?? undefined,
            cwd: entry.cwd,
            stderr: "ignore",
        });
    }

    if (entry.url) {
        // HTTP transport — try StreamableHTTP first, fall back to SSE
        const url = new URL(entry.url);
        const headers = resolveServerHeaders(entry);
        const requestInit: RequestInit | undefined = headers
            ? { headers: headers as HeadersInit }
            : undefined;

        try {
            const transport = new StreamableHTTPClientTransport(url, { requestInit });
            // Test with a probe client
            const probe = new Client({ name: "spindle-probe", version: "1.0.0" });
            await probe.connect(transport);
            await probe.close().catch(() => {});
            await transport.close().catch(() => {});
            // Success — create fresh transport for real use
            return new StreamableHTTPClientTransport(url, { requestInit });
        } catch {
            // Fall back to SSE
            await Promise.resolve(); // Allow cleanup
            return new SSEClientTransport(url, { requestInit });
        }
    }

    throw new Error("Server entry must have either 'command' (stdio) or 'url' (HTTP)");
}

function registerHandlers(client: Client, serverName: string): void {
    // Dynamically import schemas and register handlers
    // We do this inline to avoid top-level import issues

    if (_handlers.onSampling) {
        const handler = _handlers.onSampling;
        import("@modelcontextprotocol/sdk/types.js").then(({ CreateMessageRequestSchema }) => {
            client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
                const params = request.params;
                const result = await handler({
                    messages: params.messages,
                    systemPrompt: params.systemPrompt,
                    maxTokens: params.maxTokens,
                    temperature: params.temperature,
                    modelPreferences: params.modelPreferences,
                });
                return result;
            });
        }).catch(() => {});
    }

    if (_handlers.onElicitation) {
        const handler = _handlers.onElicitation;
        import("@modelcontextprotocol/sdk/types.js").then(({ ElicitRequestSchema }) => {
            client.setRequestHandler(ElicitRequestSchema, async (request) => {
                const params = request.params;
                return handler({
                    message: params.message,
                    requestedSchema: (params as any).requestedSchema,
                });
            });
        }).catch(() => {});
    }

    if (_handlers.onRoots) {
        const handler = _handlers.onRoots;
        import("@modelcontextprotocol/sdk/types.js").then(({ ListRootsRequestSchema }) => {
            client.setRequestHandler(ListRootsRequestSchema, async () => {
                return handler();
            });
        }).catch(() => {});
    }
}

async function connectServer(serverName: string): Promise<ManagedConnection> {
    // Check for existing connection
    const existing = _connections.get(serverName);
    if (existing?.status === "connected") {
        touchConnection(existing);
        return existing;
    }

    // Dedupe concurrent connect attempts
    const pending = _connectPromises.get(serverName);
    if (pending) return pending;

    const promise = doConnect(serverName);
    _connectPromises.set(serverName, promise);

    try {
        const conn = await promise;
        _connections.set(serverName, conn);
        return conn;
    } finally {
        _connectPromises.delete(serverName);
    }
}

async function doConnect(serverName: string): Promise<ManagedConnection> {
    const resolved = _servers.get(serverName);
    if (!resolved) {
        const available = [..._servers.keys()];
        throw new Error(
            `Unknown MCP server "${serverName}".` +
            (available.length > 0 ? ` Available: ${available.join(", ")}` : " No servers configured.")
        );
    }

    const entry = resolved.entry;
    const capabilities = buildCapabilities();

    const client = new Client(
        { name: "spindle", version: "0.3.0" },
        { capabilities },
    );

    const transport = await createTransport(entry);

    const conn: ManagedConnection = {
        client,
        transport,
        serverName,
        status: "connecting",
        lastUsedAt: Date.now(),
    };

    // Register server→client handlers before connecting
    registerHandlers(client, serverName);

    // Connect with timeout
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Connection to "${serverName}" timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS)
    );

    await Promise.race([connectPromise, timeoutPromise]);

    conn.status = "connected";
    touchConnection(conn);

    // Refresh metadata cache in background
    refreshCache(serverName, client).catch(() => {});

    return conn;
}

async function disconnectServer(serverName: string): Promise<void> {
    const conn = _connections.get(serverName);
    if (!conn) return;

    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.status = "closed";
    _connections.delete(serverName);

    try {
        await conn.client.close();
    } catch { /* best effort */ }
    try {
        await conn.transport.close();
    } catch { /* best effort */ }
}

async function refreshCache(serverName: string, client: Client): Promise<void> {
    try {
        const allTools: McpToolInfo[] = [];
        let cursor: string | undefined;

        do {
            const result = await client.listTools(cursor ? { cursor } : undefined);
            for (const tool of result.tools ?? []) {
                allTools.push({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                });
            }
            cursor = result.nextCursor;
        } while (cursor);

        updateCache(serverName, allTools);
    } catch {
        // Cache refresh is best-effort
    }
}

// --- REPL Builtins ---

/**
 * mcp(server?) — Discovery builtin.
 *   mcp()                      → list all servers with status
 *   mcp("server")              → list tools (from cache or live)
 *   mcp("server", {schema: true}) → include parameter schemas
 */
export async function mcpList(
    server?: string,
    opts?: { schema?: boolean },
): Promise<ToolResult> {
    try {
        if (!_initialized) mcpInit(_cwd);

        if (!server) {
            // List all servers
            if (_servers.size === 0) {
                return ToolResult.success(
                    "No MCP servers configured.\n" +
                    "Config: ~/.pi/agent/mcp.json (global) or .pi/mcp.json (project)"
                );
            }

            const lines: string[] = [`MCP servers (${_servers.size}):`];
            for (const [name, resolved] of _servers) {
                const conn = _connections.get(name);
                const status = conn?.status === "connected" ? "●" : "○";
                const source = resolved.source === "project" ? "[project]"
                    : resolved.source === "global" ? "[global]"
                    : `[${resolved.source}]`;
                let line = `  ${status} ${name} ${source}`;
                if (resolved.entry.description) {
                    line += ` — ${resolved.entry.description}`;
                }
                lines.push(line);
            }
            return ToolResult.success(lines.join("\n"));
        }

        // List tools for a specific server
        const includeSchema = opts?.schema ?? false;

        // Try cache first
        const cached = getCachedTools(server);
        if (cached && cached.length > 0) {
            return formatToolList(server, cached, includeSchema, true);
        }

        // No cache — need a live connection
        const conn = await connectServer(server);
        const allTools: McpToolInfo[] = [];
        let cursor: string | undefined;

        do {
            const result = await conn.client.listTools(cursor ? { cursor } : undefined);
            for (const tool of result.tools ?? []) {
                allTools.push({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                });
            }
            cursor = result.nextCursor;
        } while (cursor);

        updateCache(server, allTools);
        return formatToolList(server, allTools, includeSchema, false);
    } catch (err: any) {
        return ToolResult.fail(err.message || String(err));
    }
}

function formatToolList(
    server: string,
    tools: CachedToolInfo[],
    includeSchema: boolean,
    fromCache: boolean,
): ToolResult {
    if (tools.length === 0) {
        return ToolResult.success(`Server "${server}" has no tools.`);
    }

    const lines = tools.map(t => {
        let line = `  ${t.name}`;
        if (t.description) {
            const desc = t.description.length > 100
                ? t.description.slice(0, 100) + "..."
                : t.description;
            line += ` — ${desc}`;
        }
        if (includeSchema && t.inputSchema) {
            line += `\n    Schema: ${JSON.stringify(t.inputSchema)}`;
        }
        return line;
    });

    const suffix = fromCache ? " (cached)" : "";
    return ToolResult.success(
        `${server} (${tools.length} tools)${suffix}:\n` + lines.join("\n")
    );
}

/**
 * mcp_call(server, tool, args?) — One-shot tool call.
 * Lazy-connects if needed. Reuses pooled connections.
 */
export async function mcpCall(
    server: string,
    toolName: string,
    args?: Record<string, unknown>,
): Promise<ToolResult> {
    try {
        if (!_initialized) mcpInit(_cwd);

        const conn = await connectServer(server);
        touchConnection(conn);

        const result = await conn.client.callTool({
            name: toolName,
            arguments: args,
        });

        const text = extractResultText(result);
        if (result.isError) {
            return ToolResult.fail(text);
        }
        return ToolResult.success(text);
    } catch (err: any) {
        return ToolResult.fail(err.message || String(err));
    }
}

/**
 * mcp_connect(server) — Returns a persistent connection proxy.
 * Methods map to tool calls on the server.
 *
 * Unlike other builtins, throws on error (not ToolResult)
 * because the return value is stored in a REPL variable.
 */
export async function mcpConnect(server: string): Promise<unknown> {
    if (!_initialized) mcpInit(_cwd);

    const conn = await connectServer(server);

    // Build a proxy that maps method calls to tool calls
    // Get the tool list for method name mapping
    let tools: McpToolInfo[] = getCachedTools(server) ?? [];
    if (tools.length === 0) {
        // Fetch live
        const allTools: McpToolInfo[] = [];
        let cursor: string | undefined;
        do {
            const result = await conn.client.listTools(cursor ? { cursor } : undefined);
            for (const tool of result.tools ?? []) {
                allTools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
            }
            cursor = result.nextCursor;
        } while (cursor);
        tools = allTools;
        updateCache(server, tools);
    }

    // Build tool name lookup (camelCase → original)
    const toolMap = new Map<string, string>();
    for (const t of tools) {
        toolMap.set(t.name, t.name);
        // Also allow camelCase access
        const camel = t.name.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
        if (camel !== t.name) toolMap.set(camel, t.name);
    }

    const proxy = new Proxy({} as Record<string, unknown>, {
        get(_target, prop: string | symbol) {
            if (typeof prop !== "string") return undefined;

            // Special properties
            if (prop === "tools") return tools.map(t => t.name);
            if (prop === "server") return server;
            if (prop === "disconnect") return () => mcpDisconnect(server);

            const toolName = toolMap.get(prop);
            if (!toolName) return undefined;

            return async (args?: Record<string, unknown>) => {
                try {
                    const c = await connectServer(server);
                    touchConnection(c);
                    const result = await c.client.callTool({
                        name: toolName,
                        arguments: args,
                    });
                    const text = extractResultText(result);
                    if (result.isError) {
                        return ToolResult.fail(text);
                    }
                    return ToolResult.success(text);
                } catch (err: any) {
                    // Don't throw — return error-shaped result
                    // (host-context rejections can escape the REPL's vm context)
                    return ToolResult.fail(`MCP call failed: ${err.message || String(err)}`);
                }
            };
        },
    });

    return proxy;
}

/**
 * mcp_disconnect(server?) — Close connections.
 *   mcp_disconnect()         → close all
 *   mcp_disconnect("server") → close specific
 */
export async function mcpDisconnect(server?: string): Promise<ToolResult> {
    try {
        if (server) {
            await disconnectServer(server);
            return ToolResult.success(`Disconnected from "${server}".`);
        } else {
            const names = [..._connections.keys()];
            for (const name of names) {
                await disconnectServer(name);
            }
            return ToolResult.success(
                names.length > 0
                    ? `Disconnected ${names.length} server(s).`
                    : "No active connections."
            );
        }
    } catch (err: any) {
        return ToolResult.fail(err.message || String(err));
    }
}

/**
 * Cleanup all MCP connections. Called on session shutdown.
 */
export async function mcpCleanup(): Promise<void> {
    const names = [..._connections.keys()];
    for (const name of names) {
        await disconnectServer(name);
    }
    _connections.clear();
    _connectPromises.clear();
    _initialized = false;
}

// --- Helpers ---

/**
 * Extract readable text from an MCP call result.
 */
function extractResultText(result: unknown): string {
    if (result === null || result === undefined) return "(empty result)";
    if (typeof result === "string") return result;

    if (typeof result === "object" && "content" in (result as any)) {
        const content = (result as any).content;
        if (Array.isArray(content)) {
            return content
                .map((c: any) => {
                    if (c.type === "text" && c.text) return c.text;
                    if (c.type === "image") return `[Image: ${c.mimeType ?? "unknown"}]`;
                    if (c.type === "audio") return `[Audio: ${c.mimeType ?? "unknown"}]`;
                    if (c.type === "resource") return `[Resource: ${c.resource?.uri ?? "unknown"}]`;
                    return JSON.stringify(c);
                })
                .join("\n");
        }
    }

    return JSON.stringify(result, null, 2);
}
