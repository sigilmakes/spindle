# Orchestration Patterns

## Data-driven parallelism

```js
modules = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))
workers = modules.map(f => subagent(`Review ${f} for bugs`))
results = await Promise.all(workers.map(w => w.result))

bugs = results.filter(r => r.findings.some(f => f.includes('bug')))
clean = results.filter(r => r.ok && r.blockers.length === 0)
```

## Pipeline: analyze then fix

```js
// Phase 1: explore (no worktree)
analysis = await subagent("identify top 3 refactoring opportunities in src/").result

// Phase 2: implement (worktrees for isolation)
workers = analysis.findings.map(f => subagent(f, { worktree: true }))
results = await Promise.all(workers.map(w => w.result))

// Merge successful
for (let i = 0; i < workers.length; i++) {
    if (results[i].ok) {
        await bash({ command: `git merge ${workers[i].branch}` })
    }
}
```

## Subagent and continue

```js
// Call 1: spawn
h = subagent("add comprehensive tests for the parser", { worktree: true })

// Call 2: agent does other work (read, edit, bash — outside REPL)

// Call 3: collect
r = await h.result
if (r.ok) await bash({ command: `git merge ${r.branch}` })
```

## Selective collection

```js
workers = [
    subagent("fast: lint fixes", { worktree: true }),
    subagent("slow: full refactor", { worktree: true }),
    subagent("medium: update docs", { worktree: true }),
]

// Poll
while (workers.some(w => w.status === "running")) {
    await sleep(5000)
    for (const w of workers) {
        if (w.status === "done") console.log(`${w.id} finished`)
    }
}
```

## Pre-defined agents

```js
r = await subagent("find deprecated APIs", { agent: "scout" }).result
```

## Error handling

```js
r = await h.result
if (!r.ok) {
    console.log("Failed:", r.summary)
    r.blockers.forEach(b => console.log("Blocked:", b))
    // Worktree preserved for inspection
    console.log("Inspect:", r.worktree)
}
```
