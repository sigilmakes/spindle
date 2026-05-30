# Spindle

Persistent JavaScript runtime for [pi](https://github.com/badlogic/pi-mono), with a **proper Node environment**, **sync subagents**, full MCP support, and optional git worktree isolation.

## Install

```bash
pi install git:github.com/sigilmakes/spindle
```

## What changed

Spindle is no longer centered on async tmux subagents and a fake `vm` REPL.

The current direction is:
- a persistent JS runtime with real Node globals
- `require`, `process`, `Buffer`, and dynamic `import()` work
- subagents are **synchronous by default**
- child execution uses **RPC**, not a poller and status-file loop
- tmux is no longer the primary execution path

## Quick start

```js
// Real Node runtime
fs = require('node:fs')
path = await import('node:path')
console.log(process.version)

// Sync subagent
r = await subagent("find all auth-related code in src/")
r.findings

// Isolated implementation call
r = await subagent("refactor auth to use JWT", { worktree: true })
await bash({ command: `git merge ${r.branch}` })

// MCP
r = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })
```

## Architecture

```text
Main pi session
├── spindle_exec
│   └── Persistent JS runtime (Node environment)
│       ├── tool wrappers (read, bash, grep, ...)
│       ├── file I/O helpers (load, save)
│       ├── sync subagent(task, opts) -> AgentResult
│       └── MCP builtins
├── spindle_status
└── /spindle command (reset, config, cleanup, mcp)

Sync subagent call
└── pi --mode rpc --no-session [...]
    └── child session returns a structured <episode> block
```

## REPL / runtime

Spindle's persistent runtime supports:
- `require('node:fs')`
- `await import('node:path')`
- `process`, `Buffer`, `globalThis`
- persistent variables across calls

The runtime still provides built-in tool wrappers and helpers:
- `read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`
- `load`, `save`
- `subagent`
- `mcp`, `mcp_call`, `mcp_connect`, `mcp_disconnect`
- `sleep`, `diff`, `retry`, `vars`, `clear`
- `inspectVar`, `keys`, `shape`, `sample`, `preview`, `help`

When output is truncated, inspect it programmatically. The full result is still in runtime state:
- `_last`, `_lastValue`, `_lastResult`
- `_lastOutput`, `_lastFullOutput`
- `_lastError`, `_lastDurationMs`, `_lastStatus`, `_lastTruncated`

## Subagents

### `subagent(task, opts?)`

Runs a child agent call **synchronously** and returns an `AgentResult`.

**Options:** `{ agent?, model?, tools?, timeout?, worktree?, name?, systemPromptSuffix? }`

- `worktree: false` (default) — child works in the same directory
- `worktree: true` — child gets its own git worktree + branch

### `AgentResult`

```ts
{
    status: "success" | "failure" | "blocked",
    summary: string,
    findings: string[],
    artifacts: string[],
    blockers: string[],
    text: string,
    ok: boolean,
    cost: number,
    model: string,
    turns: number,
    toolCalls: number,
    durationMs: number,
    exitCode: number,
    branch?: string,
    worktree?: string,
}
```

## MCP Integration

Spindle includes a full MCP client built on the raw `@modelcontextprotocol/sdk`. Supports the complete protocol including server→client features (sampling, elicitation, roots) that other MCP integrations don't have.

### Configuration

```json
// ~/.pi/agent/mcp.json (global) or .pi/mcp.json (project, higher priority)
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "description": "Library documentation. Up-to-date API references."
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "description": "Chrome browser automation and debugging."
    }
  },
  "imports": ["cursor", "claude-code"]
}
```

### Usage

```js
await mcp()                    // list servers with connection status
await mcp("context7")         // list tools (from cache or live)
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
| `/spindle status` | Show runtime state |

## Requirements

- **git** — required for `worktree: true`
- **pi** — the coding agent

## License

MIT
