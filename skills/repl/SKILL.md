---
name: spindle-repl
description: Persistent JavaScript REPL for orchestration — async subagents in tmux sessions, file I/O, tool wrappers, MCP. Use when chaining operations, spawning parallel agents, or transforming data programmatically.
---

# Spindle REPL

Execute JavaScript in a persistent REPL via `spindle_exec`. State persists across calls.

## When to use

- **Spawn subagents** — `subagent()` for parallel/async work
- **Chain operations** — grep → filter → map → subagent
- **Transform data** — load files, parse, aggregate in JS
- **Persist state** — variables survive across `spindle_exec` calls

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
