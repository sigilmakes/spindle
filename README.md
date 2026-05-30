# Spindle

Persistent JavaScript orchestration for [pi](https://github.com/earendil-works/pi-coding-agent), with **threads**: simple programmatic workflows for sync subagents, phases, parallelism, caching, structured outputs, MCP, and rich TUI status.

## Install

```bash
pi install git:github.com/sigilmakes/spindle
```

## The shape

Spindle exposes one agent-facing tool: `spindle`.

```js
// Scratch thread / orchestration code
spindle({ code: `
phase("Explore")
const scout = await agent("Find auth code and summarize the flow", { label: "scout" })
return answer.done(scout.summary)
` })

// Saved thread
spindle({ name: "review", args: { area: "src/auth" } })

// Inspect
spindle({ inspect: "threads" })
spindle({ inspect: "status" })
```

Plain code still runs in the persistent Node runtime. Code using `phase()`, `agent()`, `parallel()`, `pipeline()`, `answer.done()`, or a `meta` export runs as a rich thread with observable phases and agent nodes.

## Quick start

```js
// Real Node runtime
fs = require("node:fs")
path = await import("node:path")
console.log(process.version)

// Sync subagent
r = await subagent("find all auth-related code in src/")
r.findings

// Thread DSL
phase("Review")
results = await parallel([
    () => agent("Review auth for security issues", { label: "security" }),
    () => agent("Review auth for maintainability", { label: "maintainer" }),
])
return answer.done(results.map(r => r.summary))

// MCP
r = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })
```

## Saved threads

Project threads live in `.pi/threads/*.js`; global threads live in `~/.pi/agent/threads/*.js`.

```js
export const meta = {
    name: "review",
    description: "Run a parallel code review",
    phases: [
        { title: "Scan", detail: "Map the target area" },
        { title: "Review", detail: "Shard specialist reviewers" },
    ],
}

phase("Scan")
const files = await agent(`List the important files for ${args.area}`, { label: "scout" })

phase("Review")
const reviews = await parallel([
    () => agent(`Security review for ${args.area}`, { label: "security" }),
    () => agent(`Test-gap review for ${args.area}`, { label: "tests" }),
])

return answer.done({ files, reviews })
```

Run with:

```js
spindle({ name: "review", args: { area: "src/" } })
```

or from the operator console:

```text
/spindle threads
/spindle run review
/spindle save-thread review
```

## Runtime builtins

- Tool wrappers: `read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`
- File I/O: `load`, `save`
- Agents: `subagent`, `agent` inside threads
- Threads: `thread`, `threads`, `phase`, `parallel`, `pipeline`, `answer.done()`
- MCP: `mcp`, `mcp_call`, `mcp_connect`, `mcp_disconnect`
- Utilities: `sleep`, `diff`, `retry`, `vars`, `clear`, `inspectVar`, `keys`, `shape`, `sample`, `preview`, `help`

When output is truncated, inspect it programmatically. The full result is still in runtime state:

- `_last`, `_lastValue`, `_lastResult`
- `_lastOutput`, `_lastFullOutput`
- `_lastError`, `_lastDurationMs`, `_lastStatus`, `_lastTruncated`

## Subagents

`subagent(task, opts?)` runs a child pi call synchronously and returns an `AgentResult`.

Options: `{ agent?, model?, tools?, timeout?, worktree?, name?, systemPromptSuffix? }`

- `worktree: false` (default) — child works in the same directory
- `worktree: true` — child gets its own git worktree + branch

## MCP Integration

Spindle includes a full MCP client built on `@modelcontextprotocol/sdk`.

Config: `~/.pi/agent/mcp.json` or `.pi/mcp.json`.

```js
await mcp()
await mcp("context7")
r = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })

c7 = await mcp_connect("context7")
r = await c7.resolveLibraryId({ libraryName: "react" })
await mcp_disconnect("context7")
```

## Commands

| Command | Description |
|---------|-------------|
| `/spindle reset` | Reset runtime state |
| `/spindle config subModel <model>` | Set default subagent model |
| `/spindle cleanup` | Remove orphaned worktrees, branches, tmux sessions |
| `/spindle mcp` | List MCP servers |
| `/spindle mcp reload` | Reload MCP config |
| `/spindle threads` | List saved threads and recent runs |
| `/spindle run <name>` | Run a saved thread |
| `/spindle save-thread <name>` | Create a project thread from a template |
| `/spindle status` | Show runtime state |

## Requirements

- **pi** — the coding agent
- **git** — required for `worktree: true`

## License

MIT
