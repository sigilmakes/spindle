---
name: mcp
description: >
  How to discover, configure, and call MCP servers from the Spindle REPL.
  Use when you need to find, add, or use MCP tools.
---

# MCP (Model Context Protocol)

MCP lets you call external services from the Spindle REPL. All MCP builtins are documented in the **[repl skill](../repl/SKILL.md)**.

## Find available servers

```javascript
await mcp()                           // list configured servers
await mcp("context7")                 // list tools on a server
await mcp("context7", { schema: true }) // include parameter schemas
```

Start with `mcp()` to see what's configured. Then `mcp("server")` to see its tools. Use `{ schema: true }` when you need to know exact parameter names and types.

## Call a tool

```javascript
result = await mcp_call("context7", "resolve-library-id", { query: "react hooks", libraryName: "react" })
console.log(result.output)
```

`mcp_call` returns a `ToolResult` — check `.ok`, read `.output` or `.error`.

For repeated calls to the same server, use a persistent proxy:

```javascript
linear = await mcp_connect("linear")
await linear.createIssue({ title: "Bug", team: "ENG" })
await linear.searchDocumentation({ query: "API" })
await mcp_disconnect("linear")
```

The proxy maps camelCase methods to tool names, validates args against the schema, and pools connections.

## Get usage guides for tools

Use `{ schema: true }` to see what parameters a tool expects:

```javascript
await mcp("context7", { schema: true })
```

This prints each tool's name, description, and full JSON schema — required fields, types, defaults, and descriptions. Read the parameter descriptions carefully; MCP tool APIs vary widely.

## Add a new server

Edit `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp"
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "headers": {
        "Authorization": "Bearer ${LINEAR_API_KEY}"
      }
    }
  }
}
```

Two transport types:

| Type | Fields | Example |
|------|--------|---------|
| **HTTP** | `url`, optional `headers` | Remote APIs (Linear, Vercel, Context7) |
| **Stdio** | `command`, `args`, optional `env`, `cwd` | Local tools (Chrome DevTools, filesystem MCPs) |

Environment variables in headers and env use `${VAR}` interpolation.

After editing the config, reset the runtime to pick up changes:

```javascript
await mcp_disconnect()   // clears cached connections
await mcp()              // re-reads config, lists servers
```

## Auth

Depends on the server:

- **No auth** — just add the URL (e.g. Context7)
- **API key** — set an env var, reference in headers: `"Authorization": "Bearer ${MY_API_KEY}"`
- **OAuth** — run `npx mcporter auth <server>` once in a terminal to complete the browser flow. Tokens are cached in `~/.mcporter/<server>/`

## Quick reference

| Builtin | Purpose |
|---------|---------|
| `mcp()` | List servers |
| `mcp("server")` | List tools |
| `mcp("server", { schema: true })` | List tools with parameter schemas |
| `mcp_call(server, tool, args)` | One-shot call → `ToolResult` |
| `mcp_connect(server)` | Persistent proxy → `ServerProxy` |
| `mcp_disconnect(server?)` | Close connections |
