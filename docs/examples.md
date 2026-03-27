# Examples

## Explore a codebase

```js
r = await subagent("find all authentication-related code and summarize the auth flow").result
console.log(r.summary)
r.findings.forEach(f => console.log("-", f))
```

## Parallel review

```js
files = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))
workers = files.map(f => subagent(`Review ${f} for security issues`))
results = await Promise.all(workers.map(w => w.result))

// Report
for (let i = 0; i < workers.length; i++) {
    console.log(`${workers[i].id}: ${results[i].status}`)
    results[i].findings.forEach(f => console.log("  -", f))
}
```

## Implement with worktree

```js
h = subagent("add input validation to all API endpoints", { worktree: true })
// agent keeps working on other things...
r = await h.result
if (r.ok) {
    await bash({ command: `git merge ${r.branch}` })
}
```

## Fire and forget

```js
subagent("refactor auth to use JWT", { worktree: true })
subagent("add comprehensive parser tests", { worktree: true })
subagent("update deprecated API calls", { worktree: true })
// notifications arrive as each finishes
```

## Collect selectively

```js
workers = [
    subagent("fast: lint fixes", { worktree: true }),
    subagent("slow: full refactor", { worktree: true }),
    subagent("medium: docs update", { worktree: true }),
]

// Collect the fast one first
r0 = await workers[0].result

// Check others
done = workers.filter(w => w.status === "done")
running = workers.filter(w => w.status === "running")
```

## Pipeline: analyze then fix

```js
// Explore (no worktree — read-only)
analysis = await subagent("identify the top 3 refactoring opportunities in src/").result

// Implement each (worktree — isolated writes)
workers = analysis.findings.map(f => subagent(f, { worktree: true }))
results = await Promise.all(workers.map(w => w.result))

// Merge successful ones
for (let i = 0; i < workers.length; i++) {
    if (results[i].ok) {
        await bash({ command: `git merge ${workers[i].branch}` })
    }
}
```

## Using pre-defined agents

```js
// Agent defined in ~/.pi/agent/agents/scout.md
r = await subagent("find all uses of deprecated APIs", { agent: "scout" }).result
r.findings.forEach(f => console.log(f))
```

## Cancel a stuck subagent

```js
h = subagent("some task that might hang")
await sleep(60000)
if (h.status === "running") {
    await h.cancel()
}
```

## Attach to watch

```
/spindle list        — see all subagents
/spindle attach w0   — jump to w0's tmux session
```
