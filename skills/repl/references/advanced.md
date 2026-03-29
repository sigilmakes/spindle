# Advanced Usage

## REPL internals

The REPL runs code in a Node.js `vm.Context`. Top-level `const`/`let`/`var` declarations are hoisted to bare assignments so they persist across `spindle_exec` calls.

```js
// Call 1
const x = 42
// Internally transformed to: x = 42

// Call 2
x  // → 42  (persists on the vm context)
```

File execution (`spindle_exec({ file: "path.js" })`) skips hoisting — declarations keep their normal scoping.

## ToolResult

All tool wrappers return `ToolResult`:

```js
const r = await bash({ command: "npm test" })
r.output    // stdout
r.error     // stderr
r.ok        // exitCode === 0
r.exitCode  // raw exit code

// ToolResult coerces to string
`${r}`  // → r.output
```

Tool wrappers never throw. Errors are always captured in the result.

## load() and save()

`load()` bypasses the agent's context window — reads directly into the REPL:

```js
// Single file → string
content = await load("src/parser.ts")

// Directory → Map<relativePath, content>
files = await load("src/")
[...files.entries()].filter(([k, v]) => v.includes("TODO"))
```

`save()` writes without entering context:

```js
await save("report.json", JSON.stringify(data, null, 2))
```

## MCP

### Configuration

MCP servers are configured in JSON files, merged with priority:

1. **`.pi/mcp.json`** (project-local, highest priority)
2. **`~/.pi/agent/mcp.json`** (global)
3. **Editor imports** (Cursor, Claude Desktop, VS Code, etc.)

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "description": "Library documentation. Up-to-date API references."
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "description": "Chrome browser automation and debugging."
    }
  },
  "imports": ["cursor", "claude-code"]
}
```

The `description` field is injected into the system prompt so the agent knows what servers are available without discovery calls.

Server entries support:
- `command` + `args` + `env` + `cwd` — stdio transport
- `url` + `headers` — HTTP transport (StreamableHTTP with SSE fallback)
- `description` — human-readable, shown in system prompt
- `idleTimeout` — minutes before idle disconnect (default: 10, 0 to disable)

Environment variables use `${VAR}` interpolation (with `${VAR:-default}` fallback):

```json
{
  "headers": {
    "Authorization": "Bearer ${LINEAR_API_KEY}"
  }
}
```

### Discovery

```js
// List all configured servers (no connections needed)
await mcp()

// List tools for a server (reads cache, connects if needed)
await mcp("context7")

// Include full parameter schemas
await mcp("context7", { schema: true })
```

### Calling tools

```js
// One-shot call (lazy-connects if needed)
r = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })

// Persistent proxy with camelCase method access
c7 = await mcp_connect("context7")
r = await c7.resolveLibraryId({ libraryName: "react" })
docs = await c7.getLibraryDocs({ context7CompatibleLibraryID: r.output, topic: "hooks" })

// Disconnect
await mcp_disconnect("context7")
// Or disconnect all
await mcp_disconnect()
```

### Connection lifecycle

Connections are lazy — nothing connects until the first call. After a configurable idle period (default 10 minutes), connections are automatically closed. The next call transparently reconnects.

Tool metadata is cached to disk (`~/.pi/agent/mcp-cache.json`) so `mcp("server")` can return results without a live connection.

### Server→client features

Spindle's MCP client supports the full protocol including server-initiated requests:

- **Roots**: Servers can ask what filesystem roots are available. Returns the current working directory.
- **Elicitation**: Servers can ask for user input. Routes to pi's UI (confirm dialogs).
- **Sampling**: Servers can request LLM inference. Currently returns a passthrough response; full LLM routing is planned.

### Commands

```
/spindle mcp           — list configured servers
/spindle mcp reload    — reload config files
```

## Session persistence

REPL config (sub-model) persists across pi session restarts via `pi.appendEntry()`. Variables and worker handles do not persist — they exist only in the current session's REPL.
