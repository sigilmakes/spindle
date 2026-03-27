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

```js
// Discover
await mcp()                    // list servers
await mcp("context7")          // list tools
await mcp("context7", { schema: true })  // include param schemas

// One-shot call
r = await mcp_call("context7", "resolve", { query: "react hooks" })

// Persistent proxy
proxy = await mcp_connect("context7")
await mcp_disconnect("context7")
```

## Session persistence

REPL config (sub-model) persists across pi session restarts via `pi.appendEntry()`. Variables and worker handles do not persist — they exist only in the current session's REPL.
