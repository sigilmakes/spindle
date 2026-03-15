---
name: spindle
description: Persistent JavaScript REPL for programmatic tool calling, sub-agent orchestration, and parallel dispatch. Use when you need loops, data transformation, multi-agent coordination, or to call tools as functions in code.
---

# Spindle REPL

Persistent JavaScript REPL via `spindle_exec`. Write code that calls tools as functions — loops, conditionals, pipelines. Variables persist across calls with plain assignment (not const/let). Output truncated to 8192 chars; store results in variables.

## Built-in tools

```javascript
await read({ path: "src/foo.ts" })
await bash({ command: "npm test" })
await grep({ pattern: "TODO", path: "src/" })
await find({ pattern: "*.ts", path: "src/" })
await edit({ path: "src/foo.ts", oldText: "old", newText: "new" })
await write({ path: "out.md", content: report })
await ls({ path: "src/" })
```

These have pi's truncation limits (50KB/2000 lines). Use `load()` for full content.

## File I/O (bypasses context)

```javascript
data = await load("src/auth/")       // directory → Map<path, content>
text = await load("big-file.json")    // file → string, no truncation
await save("docs/report.md", content) // write without entering context
```

## Sub-agents

```javascript
// One-shot — returns string
answer = await llm("summarize this code: " + code)
answer = await llm("search for auth bugs", { agent: "scout", model: "...", tools: ["read"], timeout: 60000 })

// Parallel dispatch — returns Episode[]
results = await dispatch([
    thread("analyze auth module", { agent: "scout" }),
    thread("check test coverage", { agent: "scout" }),
    thread("find security issues", { agent: "scout" }),
])

// Each episode has: status, summary, findings, artifacts, blockers, cost, duration
for (const ep of results) {
    console.log(ep.status, ep.summary)
    console.log(ep.findings)
}
```

Sub-agents are full pi processes with ALL tools (mcp, extensions, bash, etc.).

## Recursive Spindle

Pass `{ spindle: true }` to give a sub-agent its own Spindle REPL:

```javascript
results = await dispatch([
    thread("refactor the auth module", { agent: "worker", spindle: true }),
    thread("refactor the API layer", { agent: "worker", spindle: true }),
])
// Each worker can dispatch its own sub-agents internally
```

## Thread communication

Threads in a dispatch can send messages to each other by rank:

```javascript
results = await dispatch([
    thread("define the types, then broadcast them", { agent: "worker", spindle: true }),
    thread("wait for types from rank 0, then implement", { agent: "worker", spindle: true }),
], { communicate: true })
```

Inside communicating threads, these tools are available:
- `spindle_send({ to: 1, msg: "types defined", data: { fields: [...] } })` — point-to-point
- `spindle_recv({ from: 0 })` — blocking receive (optional sender filter)
- `spindle_broadcast({ msg: "breaking change" })` — send to all other threads

## Stepped threads

Threads can yield intermediate episodes during execution:

```javascript
t = thread("complex refactor", { agent: "worker", stepped: true })
for await (const ep of t) {
    console.log(ep.status, ep.summary)
    if (ep.status === "blocked") break
}
```

## Script execution

```javascript
spindle_exec({ file: "workflows/audit.js" })
```

Runs a `.js`/`.mjs` file in the same REPL context with all builtins available.

## Utilities

```javascript
await sleep(2000)
```

## When to use Spindle vs normal tools

- **Normal tool calls**: one-off reads, edits, bash commands
- **Spindle**: loops over files, multi-step pipelines, parallel sub-agent dispatch, data processing, anything where you'd write a script
