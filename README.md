# Spindle

Async agent orchestration for [pi](https://github.com/badlogic/pi-mono). Persistent JavaScript REPL with async subagents in tmux sessions, full MCP protocol support, and optional git worktree isolation.

## Install

```bash
pi install git:github.com/sigilmakes/spindle
```

## Quick start

```js
// Explore — no worktree needed
r = await subagent("find all auth-related code in src/").result
r.findings  // ["src/auth.ts handles JWT", "src/middleware/jwt.ts validates tokens"]

// Implement — worktree for isolation
h = subagent("refactor auth to use JWT", { worktree: true })
// main agent keeps working...
r = await h.result
await bash({ command: `git merge ${r.branch}` })

// Parallel from data
files = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))
workers = files.map(f => subagent(`Review ${f}`))
results = await Promise.all(workers.map(w => w.result))

// MCP — call external tools
r = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })
```

## Architecture

Every subagent runs in its own tmux session. Optionally gets a git worktree for filesystem isolation. Status is communicated via `.spindle/status.json` files written by a worker extension that hooks pi events. The main session polls these files to update a dashboard widget and send completion notifications.

```
Main pi session
├── spindle_exec: h = subagent("task")
│   ├── [if worktree] git worktree add .worktrees/w0 -b spindle/w0
│   ├── tmux new-session -d -s spindle-w0
│   │     └── pi -p --no-session -e worker-extension.ts "Task: ..."
│   │           └── writes .spindle/status.json, parses <episode> block
│   └── returns SubagentHandle immediately
├── [agent works normally]
├── [poller detects done → dashboard update + notification]
└── spindle_exec: r = await h.result → AgentResult
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

Server descriptions are injected into the system prompt so the agent knows what's available without discovery calls. Editor configs from Cursor, Claude Desktop, VS Code, Windsurf, and Codex are auto-imported.

### Usage

```js
// Discover
await mcp()                    // list servers with connection status
await mcp("context7")          // list tools (from cache or live)

// One-shot call (lazy-connects)
r = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })

// Persistent proxy with camelCase methods
c7 = await mcp_connect("context7")
r = await c7.resolveLibraryId({ libraryName: "react" })
await mcp_disconnect("context7")
```

### Features

- **Lazy connections** — connect on first call, idle disconnect after 10 min (configurable)
- **Metadata caching** — tool discovery works without live connections
- **Config layering** — project `.pi/mcp.json` > global `~/.pi/agent/mcp.json` > editor imports
- **Progressive disclosure** — server descriptions in system prompt, drill down with `mcp("server")`
- **Full protocol** — sampling, elicitation, and roots handlers for server→client requests

### Commands

| Command | Description |
|---------|-------------|
| `/spindle mcp` | List configured servers |
| `/spindle mcp reload` | Reload config files |

## API

### subagent(task, opts?)

Spawn a subagent. Returns `SubagentHandle` immediately.

**Options:** `{ agent?, model?, tools?, timeout?, worktree?, name?, systemPromptSuffix? }`

- `worktree: false` (default) — subagent works in the same directory. Good for exploration.
- `worktree: true` — subagent gets its own git worktree + branch. Required for writes that shouldn't conflict.

### SubagentHandle

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | `"w0"`, `"w1"`, ... |
| `session` | string | tmux session name |
| `branch` | string? | git branch (if worktree) |
| `worktree` | string? | worktree path (if worktree) |
| `task` | string | original task |
| `status` | SubagentStatus | `"running"` \| `"done"` \| `"crashed"` |
| `result` | Promise\<AgentResult\> | resolves when done |
| `cancel()` | async | kill the subagent |

### AgentResult

```typescript
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

### Other builtins

| Builtin | Description |
|---------|-------------|
| `read/edit/write/bash/grep/find/ls` | Tool wrappers → ToolResult |
| `load(path)` | File → string, dir → Map |
| `save(path, content)` | Write without context |
| `mcp()` | List MCP servers or tools |
| `mcp_call(server, tool, args)` | One-shot MCP tool call |
| `mcp_connect(server)` | Persistent MCP proxy |
| `mcp_disconnect(server?)` | Close MCP connections |
| `sleep/diff/retry/vars/clear/help` | Utilities |

### Commands

| Command | Description |
|---------|-------------|
| `/spindle attach <id>` | Open subagent's tmux session |
| `/spindle list` | Show active subagents |
| `/spindle reset` | Reset REPL state |
| `/spindle config subModel <model>` | Set default subagent model |
| `/spindle cleanup` | Remove orphaned worktrees, branches, tmux sessions |
| `/spindle mcp` | List MCP servers |
| `/spindle mcp reload` | Reload MCP config |
| `/spindle status` | Show REPL state |

## Requirements

- **tmux** — required
- **git** — required for `worktree: true`
- **pi** — the coding agent

## License

MIT
