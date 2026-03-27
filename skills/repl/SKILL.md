---
name: spindle-repl
description: Persistent JavaScript REPL for orchestration — async workers, file I/O, tool wrappers, MCP. Use when chaining operations, spawning parallel agents, or transforming data programmatically.
---

# Spindle REPL

Execute JavaScript in a persistent REPL via `spindle_exec`. State persists across calls — variables, handles, results survive between invocations.

## When to use

- **Spawn async workers** — `spawn()` for parallel work in isolated worktrees
- **Chain operations** — grep → filter → map → spawn
- **Transform data** — load files, parse, aggregate in JS
- **Persist state** — variables survive across `spindle_exec` calls

Use native tools (read, edit, bash) for single operations. Use the REPL when you need composition or state.

## Core pattern

```js
// Discover → transform → act
files = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))
workers = files.map(f => spawn(`Review ${f}`, { agent: 'reviewer' }))
results = await Promise.all(workers.map(w => w.result))
```

## Workers

`spawn(task, opts?)` creates an async worker in a git worktree + tmux session. Returns a handle immediately.

```js
h = spawn("Refactor auth module")
h.status    // "running" | "done" | "crashed"
h.branch    // "spindle/w0"
r = await h.result  // blocks until done
await bash({ command: `git merge ${h.branch}` })
```

Options: `{ agent, model, tools, timeout, worktree, name }`

Workers are isolated. Each gets its own worktree and terminal. No shared state.

## LLM one-shots

`llm(prompt, opts?)` is blocking — no worktree, no tmux. For quick LLM calls.

```js
r = await llm("Summarize this code", { model: "haiku" })
r.text  // the response
r.ok    // true if successful
```

## Tool wrappers

All return `ToolResult { output, error, ok, exitCode }`. Never throw.

```js
r = await grep({ pattern: "TODO", path: "src/" })
r.output  // grep results
r.ok      // true

r = await bash({ command: "npm test" })
r.exitCode  // 0 or non-zero
```

## File I/O

```js
content = await load("src/parser.ts")     // string
files = await load("src/")                 // Map<path, content>
await save("output.json", JSON.stringify(data))
```

## Scoping

`const`, `let`, `var`, and bare assignments all persist across calls.

```js
// Call 1:
x = 42
// Call 2:
x  // → 42
```

## Commands

- `/spindle attach <id>` — open worker's tmux session
- `/spindle list` — show active workers
- `/spindle reset` — reset REPL state
- `/spindle config subModel <model>` — set default worker model
