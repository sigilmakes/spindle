---
name: repl
description: Spindle orchestration runtime — use the spindle tool for persistent Node code, programmatic subagents, MCP calls, and multi-agent workflows.
---

# Spindle Runtime

Use the `spindle` tool when a task needs composition or state. The surface:

```js
spindle({ script })              // inline workflow script
spindle({ name, args })           // saved workflow
spindle({ scriptPath, args })     // file-backed workflow
```

Use native tools for one-off reads/writes/commands. Use Spindle when you need JavaScript control flow, subagents, MCP, large-result inspection, or workflow-style phases.

## Workflow DSL

Workflow scripts must begin with `export const meta = { name, description, phases? }` and run in a deterministic VM sandbox.

```js
export const meta = {
  name: "review",
  description: "Parallel review",
  phases: [{ title: "Explore" }, { title: "Review" }],
}

phase("Explore")
const scout = await agent("Find the auth code and summarize it", { label: "scout" })

phase("Review")
const reviews = await parallel([
  () => agent("Security review of auth", { label: "security", phase: "Review" }),
  () => agent("Test-gap review of auth", { label: "tests", phase: "Review" }),
])

const synthesis = reviews.filter(Boolean).join("\n---\n")
return synthesis
```

### Globals

- `agent(prompt, opts?)` — spawn in-memory subagent. Returns `null` on failure.
- `parallel(thunks)` — concurrent fan-out. Failed thunks return `null`.
- `pipeline(items, ...stages)` — fan-out with sequential stages.
- `phase(title)` — mark current phase.
- `log(message, data?)` — append log entry.
- `args` — tool's `args` parameter.
- `budget` — `{ total, spent(), remaining() }`.
- `workflow(name, args?)` — run nested saved workflow.

### Determinism

No `Date.now()`, `Math.random()`, `require`, `import`, `fs` in workflow scripts. `meta` must be a pure literal.

## Node runtime (REPL)

Outside workflows, the persistent REPL provides full Node access:

```js
fs = require("node:fs")
path = require("node:path")
os = await import("node:os")
console.log(process.version)
```

## subagent()

```js
r = await subagent(task, opts?)
```

Runs a child agent call and returns `AgentResult` directly.

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

- `/spindle workflows` — list saved workflows and recent runs
- `/spindle agents` — list workflow agents
- `/spindle run <name>` — run a saved workflow
- `/spindle save <name>` — create workflow from template
- `/spindle attach <id>` — view agent session details
- `/spindle message <id> <text>` — send message to running agent
- `/spindle stop <runId>` — cancel a running workflow
- `/spindle status` — show runtime state
- `/spindle cleanup` — remove orphaned worktrees/branches
- `/spindle config subModel <model>` — set subagent model
- `/spindle mcp` — list MCP servers
- `/spindle mcp reload` — reload MCP config
- `/spindle reset` — reset REPL state