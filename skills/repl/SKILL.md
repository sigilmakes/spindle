---
name: repl
description: Persistent JavaScript runtime for orchestration — proper Node environment, sync subagents, file I/O, tool wrappers, and MCP integration. Use when chaining operations, transforming data, calling MCP tools, or inspecting large results programmatically.
---

# Spindle Runtime

Execute JavaScript in a persistent runtime via `spindle_exec`. State persists across calls.

## When to use

- **Chain operations** — grep → filter → map → subagent
- **Transform data** — load files, parse, aggregate in JS
- **Persist state** — variables survive across `spindle_exec` calls
- **Call sync subagents** — `await subagent(...)`
- **Call MCP servers** — `mcp_call()` / `mcp_connect()`
- **Inspect large results** — use `_lastValue`, `_lastResult`, `preview()`, `shape()`, `keys()`, `sample()`

Use native tools (read, edit, bash) for single operations. Use the runtime when you need composition or state.

## Node environment

This is a real Node-flavored runtime, not the old vm sandbox.

```js
fs = require("node:fs")
path = require("node:path")
os = await import("node:os")
console.log(process.version)
```

Available globals include:
- `require`
- `process`
- `Buffer`
- `globalThis`
- dynamic `import()`

## subagent()

```js
r = await subagent(task, opts?)
```

Runs a **synchronous** child agent call and returns `AgentResult` directly.

```js
// Explore
r = await subagent("find all auth code in src/")
r.findings

// Implement in isolated worktree
r = await subagent("refactor auth module", { worktree: true })
await bash({ command: `git merge ${r.branch}` })
```

**Options:** `{ agent, model, tools, timeout, worktree, name, systemPromptSuffix }`

- `worktree: false` (default) — works in same directory, good for exploration
- `worktree: true` — gets its own git worktree + branch, good for isolated writes

**AgentResult:**
```js
status, summary, findings[], artifacts[], blockers[],
text, ok, cost, model, turns, toolCalls, durationMs, exitCode,
branch?, worktree?
```

## MCP

Configured servers appear in the system prompt. Use `mcp_call()` for one-shot calls, `mcp_connect()` for repeated calls to the same server.

```js
await mcp()                    // list all servers
await mcp("context7")         // list tools (from cache or live)

r = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })

c7 = await mcp_connect("context7")
docs = await c7.getLibraryDocs({ context7CompatibleLibraryID: id, topic: "hooks" })
await mcp_disconnect("context7")
```

Config: `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (project).

## Tool wrappers

All return `ToolResult { output, error, ok, exitCode }`. Never throw.

```js
r = await grep({ pattern: "TODO", path: "src/" })
r = await bash({ command: "npm test" })
```

## File I/O

```js
content = await load("src/parser.ts")      // string
files = await load("src/")                 // Map<path, content>
await save("output.json", JSON.stringify(data))
```

## Inspection helpers

When output is truncated, inspect the result programmatically. The full value remains in runtime state.

Automatic vars after each `spindle_exec` call:
- `_last`
- `_lastValue`
- `_lastResult`
- `_lastOutput`
- `_lastFullOutput`
- `_lastError`
- `_lastDurationMs`
- `_lastStatus`
- `_lastTruncated`

Helpers:

```js
inspectVar("_lastResult")
keys(_lastValue)
shape(_lastValue)
sample(_lastValue, 5)
preview(_lastValue, { maxChars: 800 })
```

## Scoping

`const`, `let`, `var`, and bare assignments persist across calls.

## Commands

- `/spindle reset` — reset runtime state
- `/spindle cleanup` — remove orphaned worktrees, branches, tmux sessions
- `/spindle config subModel <model>` — default subagent model
- `/spindle mcp` — list MCP servers
- `/spindle mcp reload` — reload MCP config
