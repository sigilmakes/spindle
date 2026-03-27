# Spindle

Async agent orchestration for [pi](https://github.com/badlogic/pi-mono). Persistent JavaScript REPL with async subagents in tmux sessions and optional git worktree isolation.

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

Returned by both `await h.result` and in completion notifications.

```typescript
{
    // Episode (structured by worker extension)
    status: "success" | "failure" | "blocked",
    summary: string,
    findings: string[],
    artifacts: string[],
    blockers: string[],

    // Raw output
    text: string,
    ok: boolean,         // status === "success"

    // Metadata
    cost: number,
    model: string,
    turns: number,
    toolCalls: number,
    durationMs: number,
    exitCode: number,

    // Worktree (undefined when worktree: false)
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
| `mcp/mcp_call/mcp_connect/mcp_disconnect` | MCP integration |
| `sleep/diff/retry/vars/clear/help` | Utilities |

### Commands

| Command | Description |
|---------|-------------|
| `/spindle attach <id>` | Open subagent's tmux session |
| `/spindle list` | Show active subagents |
| `/spindle reset` | Reset REPL state |
| `/spindle config subModel <model>` | Set default subagent model |
| `/spindle status` | Show REPL state |

## Requirements

- **tmux** — required
- **git** — required for `worktree: true`
- **pi** — the coding agent

## License

MIT
