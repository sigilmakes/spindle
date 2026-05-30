---
name: repl
description: Spindle orchestration runtime — use the unified spindle tool for persistent Node code, programmatic subagents, MCP calls, and rich multi-agent threads.
---

# Spindle Runtime

Use the `spindle` tool when a task needs composition or state. The simple surface is:

```js
spindle({ code })                 // scratch orchestration
spindle({ name, args })           // saved thread
spindle({ script, args })         // inline thread
spindle({ scriptPath, args })     // file-backed thread
spindle({ inspect: "status" })
spindle({ inspect: "threads" })
```

Use native tools for one-off reads/writes/commands. Use Spindle when you need JavaScript control flow, subagents, MCP, large-result inspection, or workflow-style phases.

## Thread DSL

Code that uses `phase()`, `agent()`, `parallel()`, `pipeline()`, or `answer.done()` runs as a rich thread with visible phases and agent nodes.

```js
phase("Explore")
const scout = await agent("Find the auth code and summarize it", { label: "scout" })

phase("Review")
const reviews = await parallel([
    () => agent("Security review of auth", { label: "security" }),
    () => agent("Test-gap review of auth", { label: "tests" }),
])

return answer.done({ scout, reviews })
```

Saved threads live in `.pi/threads/*.js` or `~/.pi/agent/threads/*.js` and export metadata:

```js
export const meta = {
    name: "review",
    description: "Parallel review",
    phases: [{ title: "Explore" }, { title: "Review" }],
}
```

## Node runtime

Plain code runs in a persistent Node-flavored runtime:

```js
fs = require("node:fs")
path = require("node:path")
os = await import("node:os")
console.log(process.version)
```

Available globals include `require`, `process`, `Buffer`, `globalThis`, and dynamic `import()`.

## subagent()

```js
r = await subagent(task, opts?)
```

Runs a synchronous child agent call and returns `AgentResult` directly.

Options: `{ agent, model, tools, timeout, worktree, name, systemPromptSuffix }`.

## MCP

```js
await mcp()
await mcp("context7")
r = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })

c7 = await mcp_connect("context7")
docs = await c7.getLibraryDocs({ context7CompatibleLibraryID: id, topic: "hooks" })
await mcp_disconnect("context7")
```

## Tool wrappers

All return `ToolResult { output, error, ok, exitCode }`. They do not throw.

```js
r = await grep({ pattern: "TODO", path: "src/" })
r = await bash({ command: "npm test" })
```

## File I/O

```js
content = await load("src/parser.ts")
files = await load("src/")
await save("output.json", JSON.stringify(data))
```

## Inspection helpers

When output is truncated, the full value remains in runtime state.

Automatic vars:
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

## Commands

- `/spindle reset`
- `/spindle cleanup`
- `/spindle config subModel <model>`
- `/spindle mcp`
- `/spindle mcp reload`
- `/spindle threads`
- `/spindle run <name>`
- `/spindle save-thread <name>`
