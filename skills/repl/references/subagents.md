# Workers (Async Subagents)

Workers are async subagents that run in isolated git worktrees with their own tmux sessions.

## spawn()

```js
h = spawn(task, opts?)
```

Returns a `WorkerHandle` immediately. The worker runs in the background.

**Options:**
- `agent` — name of a pre-defined agent (from `~/.pi/agent/agents/`)
- `model` — model override
- `tools` — tool whitelist (e.g. `["read", "grep", "find"]`)
- `timeout` — kill after N ms
- `worktree` — use git worktree (default: true)
- `name` — display name
- `systemPromptSuffix` — additional system prompt text

## WorkerHandle

```js
h.id        // "w0"
h.branch    // "spindle/w0"
h.worktree  // ".worktrees/w0"
h.session   // "spindle-w0" (tmux session name)
h.task      // original task
h.status    // "running" | "done" | "crashed"
h.result    // Promise<WorkerResult>
h.cancel()  // kill the worker
```

## WorkerResult

```js
{
    status: "success" | "failure",
    summary: "What the agent accomplished...",
    findings: ["Found X", "Implemented Y"],
    artifacts: ["src/auth.ts — rewritten", "src/jwt.ts — new"],
    blockers: [],
    branch: "spindle/w0",
    worktree: "/path/to/.worktrees/w0",
    exitCode: 0,
    turns: 8,
    toolCalls: 23,
    cost: 0.04,
    model: "claude-sonnet-4-20250514",
    durationMs: 134000,
}
```

The structured episode (summary, findings, artifacts, blockers) is parsed from the agent's final response by the worker extension. The agent writes an `<episode>` block at the end of its output — this is injected via the system prompt automatically.

## Patterns

### Parallel from data
```js
files = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))
workers = files.map(f => spawn(`Review ${f}`, { agent: 'reviewer' }))
results = await Promise.all(workers.map(w => w.result))
```

### Merge successful workers
```js
for (const w of workers) {
    const r = await w.result
    if (r.status === "success") {
        await bash({ command: `git merge ${w.branch}` })
    }
}
```

### Fire and forget
```js
spawn("Refactor auth module")
spawn("Add parser tests")
// Notifications arrive as each finishes
```

### Attach to watch
```
/spindle attach w0
```

Opens the worker's tmux session — you see the full pi TUI with every tool call in real time.
