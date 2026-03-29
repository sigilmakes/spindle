---
name: repl
description: Persistent JavaScript REPL for orchestration — async subagents in tmux sessions, file I/O, tool wrappers, MCP server integration. Use when chaining operations, spawning parallel agents, calling MCP tools, or transforming data programmatically.
---

# Spindle REPL

Execute JavaScript in a persistent REPL via `spindle_exec`. State persists across calls.

## When to use

- **Spawn subagents** — `subagent()` for parallel/async work
- **Chain operations** — grep → filter → map → subagent
- **Transform data** — load files, parse, aggregate in JS
- **Persist state** — variables survive across `spindle_exec` calls
- **Call MCP servers** — `mcp_call()` for external tools and services

Use native tools (read, edit, bash) for single operations. Use the REPL when you need composition or state.

## subagent()

```js
h = subagent(task, opts?)
```

Spawns an async subagent in a tmux session. Returns a `SubagentHandle` immediately.

```js
// Explore (default — no worktree)
r = await subagent("find all auth code in src/").result
r.findings  // structured results from the subagent

// Implement (worktree for isolation)
h = subagent("refactor auth module", { worktree: true })
// main agent keeps working...
r = await h.result
await bash({ command: `git merge ${r.branch}` })
```

**Options:** `{ agent, model, tools, timeout, worktree, name }`

- `worktree: false` (default) — works in same directory, good for exploration
- `worktree: true` — gets its own git worktree + branch, required for writes

**AgentResult** (from `await h.result`):
```
status, summary, findings[], artifacts[], blockers[],
text, ok, cost, model, turns, toolCalls, durationMs, exitCode,
branch?, worktree?
```

## MCP

Configured servers appear in the system prompt. Use `mcp_call()` for one-shot calls, `mcp_connect()` for repeated calls to the same server.

```js
// Discover
await mcp()                    // list all servers
await mcp("context7")          // list tools (from cache or live)

// Call
r = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })

// Persistent proxy
c7 = await mcp_connect("context7")
docs = await c7.getLibraryDocs({ context7CompatibleLibraryID: id, topic: "hooks" })
await mcp_disconnect("context7")
```

Config: `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (project). See [[references/advanced|advanced docs]] for full config format.

## Tool wrappers

All return `ToolResult { output, error, ok, exitCode }`. Never throw.

```js
r = await grep({ pattern: "TODO", path: "src/" })
r = await bash({ command: "npm test" })
```

## File I/O

```js
content = await load("src/parser.ts")     // string
files = await load("src/")                 // Map<path, content>
await save("output.json", JSON.stringify(data))
```

## Scoping

`const`, `let`, `var`, and bare assignments persist across calls.

## Commands

- `/spindle attach <id>` — open subagent's tmux session
- `/spindle list` — show active subagents
- `/spindle reset` — reset REPL state
- `/spindle config subModel <model>` — default subagent model
- `/spindle mcp` — list MCP servers
- `/spindle mcp reload` — reload MCP config
