# Spindle

Async agent orchestration for [pi](https://github.com/badlogic/pi-mono). Persistent JavaScript REPL with async workers in isolated git worktrees and tmux sessions.

## What it does

Spindle gives the pi agent a JavaScript REPL (`spindle_exec`) for orchestration. The REPL persists state across calls — variables, handles, results all survive between tool invocations.

Workers are async subagents that run in their own git worktrees and tmux sessions. The main agent spawns them and keeps working. When a worker finishes, a notification arrives and the agent can collect results and merge branches.

## Install

```bash
pi install git:github.com/sigilmakes/spindle
```

## Quick start

```js
// Spawn an async worker — returns immediately
h = spawn("Refactor the auth module to use JWT", { worktree: true })

// Main agent keeps working on other things...

// Check status
h.status  // "running" | "done" | "crashed"

// Collect result when ready
r = await h.result
// { status: "success", summary: "...", branch: "spindle/w0", cost: 0.04, ... }

// Merge the work
await bash({ command: `git merge ${h.branch}` })
```

## Architecture

```
Main pi session (TUI)
│
├── spindle_exec: h = spawn("task", { worktree: true })
│   ├── git worktree add .worktrees/w0 -b spindle/w0
│   ├── tmux new-session -d -s spindle-w0 -c .worktrees/w0
│   │     └── pi -p --no-session --extension worker-extension.ts "Task: ..."
│   │           └── writes .spindle/status.json on every tool call
│   ├── starts polling .worktrees/w0/.spindle/status.json
│   └── returns WorkerHandle immediately
│
├── [agent uses read/edit/bash normally]
│
├── [poller detects worker done]
│   ├── updates dashboard widget
│   └── pi.sendMessage → triggers agent turn
│
└── spindle_exec: r = await h.result → WorkerResult
```

## REPL builtins

### Tools

Return `ToolResult { output, error, ok, exitCode }`. Never throw.

| Builtin | Description |
|---------|-------------|
| `read({ path })` | Read a file |
| `edit({ path, oldText, newText })` | Replace exact text |
| `write({ path, content })` | Create or overwrite |
| `bash({ command, timeout? })` | Run shell command |
| `grep({ pattern, path })` | Search with ripgrep |
| `find({ pattern, path })` | Find files by glob |
| `ls({ path })` | List directory |

### File I/O

| Builtin | Description |
|---------|-------------|
| `load(path)` | File → string, directory → `Map<path, content>` |
| `save(path, content)` | Write without entering agent context |

### Workers

| Builtin | Description |
|---------|-------------|
| `spawn(task, opts?)` | Spawn async worker → `WorkerHandle` |
| `h.status` | `"running"` \| `"done"` \| `"crashed"` |
| `h.result` | `Promise<WorkerResult>` |
| `h.branch` | Git branch (e.g. `"spindle/w0"`) |
| `h.worktree` | Worktree path |
| `h.session` | Tmux session name |
| `h.cancel()` | Kill the worker |

**SpawnOptions:** `{ agent?, model?, tools?, timeout?, worktree?, name?, systemPromptSuffix? }`

**WorkerResult:** `{ status, summary, findings[], artifacts[], blockers[], branch, worktree, exitCode, turns, toolCalls, cost, model, durationMs }`

### LLM

| Builtin | Description |
|---------|-------------|
| `llm(prompt, opts?)` | Blocking one-shot → `{ text, cost, model, turns, ok }` |

**Options:** `{ agent?, model?, tools?, timeout?, maxOutput? }`

### MCP

| Builtin | Description |
|---------|-------------|
| `mcp()` | List MCP servers |
| `mcp('server')` | List tools for a server |
| `mcp_call(server, tool, args)` | One-shot tool call |
| `mcp_connect(server)` | Persistent proxy |
| `mcp_disconnect(server?)` | Close connections |

### Utilities

| Builtin | Description |
|---------|-------------|
| `sleep(ms)` | Async delay |
| `diff(a, b, opts?)` | Unified diff |
| `retry(fn, opts?)` | Exponential backoff |
| `vars()` | List REPL variables |
| `clear(name?)` | Free a variable |
| `help()` | Show all builtins |

## Commands

| Command | Description |
|---------|-------------|
| `/spindle attach <id>` | Open worker's tmux session |
| `/spindle list` | Show active workers |
| `/spindle reset` | Reset REPL state |
| `/spindle config subModel <model>` | Set default worker model |
| `/spindle status` | Show REPL state |

## Patterns

### Parallel review

```js
files = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))
workers = files.map(f => spawn(`Review ${f} for bugs`, { agent: 'reviewer' }))
results = await Promise.all(workers.map(w => w.result))
bugs = results.filter(r => r.status === 'failure')
```

### Spawn and continue

```js
// Spawn a worker
h = spawn("Add comprehensive tests for the parser")

// Keep working on something else
await edit({ path: "src/parser.ts", oldText: "old", newText: "new" })
await bash({ command: "npm run lint -- --fix" })

// Come back later
r = await h.result
await bash({ command: `git merge ${h.branch}` })
```

### LLM one-shot

```js
summary = await llm("Summarize this in 3 bullet points: " + await load("README.md"))
console.log(summary.text)
```

## Requirements

- **tmux** — required for async workers
- **git** — required for worktree isolation (falls back to cwd without git)
- **pi** — the coding agent

## How it works

1. `spawn()` creates a git worktree (`.worktrees/<id>`) and a tmux session (`spindle-<id>`)
2. A pi process runs in the tmux session with a worker extension that writes `.spindle/status.json`
3. The main session polls status files every 2s to update the dashboard widget
4. When a worker finishes, `pi.sendMessage()` notifies the main agent
5. The agent collects results via `await handle.result` and merges branches

Workers are fully isolated — they have their own filesystem (worktree), their own terminal (tmux), and their own pi process. No shared state, no message passing, no coordination needed.

## License

MIT
