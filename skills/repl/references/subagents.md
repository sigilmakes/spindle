# Subagents

Async agents in tmux sessions with optional git worktree isolation.

## subagent()

```js
h = subagent(task, opts?)
```

Returns a `SubagentHandle` immediately. The subagent runs in its own tmux session.

**Options:**
- `agent` — pre-defined agent (from `~/.pi/agent/agents/`)
- `model` — model override
- `tools` — tool whitelist
- `timeout` — kill after N ms
- `worktree` — `false` (default): same directory. `true`: isolated git worktree + branch.
- `name` — display name
- `systemPromptSuffix` — additional prompt text

## SubagentHandle

```js
h.id        // "w0"
h.session   // "spindle-w0" (tmux session name)
h.branch    // "spindle/w0" (if worktree: true)
h.worktree  // ".worktrees/w0" (if worktree: true)
h.task      // original task
h.status    // "running" | "done" | "crashed"
h.result    // Promise<AgentResult>
h.cancel()  // kill the subagent
```

## AgentResult

```js
{
    status: "success" | "failure" | "blocked",
    summary: "What the agent accomplished...",
    findings: ["Found X", "Implemented Y"],
    artifacts: ["src/auth.ts — rewritten", "src/jwt.ts — new"],
    blockers: [],
    text: "Full raw output...",
    ok: true,
    cost: 0.04,
    model: "claude-sonnet-4-20250514",
    turns: 8,
    toolCalls: 23,
    durationMs: 134000,
    exitCode: 0,
    branch: "spindle/w0",     // if worktree: true
    worktree: ".worktrees/w0", // if worktree: true
}
```

The episode fields (status, summary, findings, artifacts, blockers) are parsed from the agent's `<episode>` block, injected automatically by the worker extension.

## Patterns

### Explore
```js
r = await subagent("find all auth-related code").result
r.findings.forEach(f => console.log(f))
```

### Parallel from data
```js
files = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))
workers = files.map(f => subagent(`Review ${f}`))
results = await Promise.all(workers.map(w => w.result))
```

### Implement and merge
```js
h = subagent("refactor auth to use JWT", { worktree: true })
r = await h.result
if (r.ok) await bash({ command: `git merge ${r.branch}` })
```

### Fire and forget
```js
subagent("refactor auth module", { worktree: true })
subagent("add parser tests", { worktree: true })
// notifications arrive as each finishes
```

### Attach to watch
```
/spindle attach w0
```
