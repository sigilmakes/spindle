# Examples

## Basic: spawn and merge

```js
h = spawn("Add input validation to all API endpoints")
// agent keeps working...
r = await h.result
if (r.status === "success") {
    await bash({ command: `git merge ${h.branch}` })
}
```

## Parallel workers from data

```js
// Find all modules, spawn a reviewer for each
files = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))
workers = files.map(f => spawn(`Review ${f} for security issues`, { agent: 'reviewer' }))

// Wait for all to finish
results = await Promise.all(workers.map(w => w.result))

// Report
for (let i = 0; i < workers.length; i++) {
    console.log(`${workers[i].id}: ${results[i].status} — ${results[i].summary.slice(0, 100)}`)
}

// Merge successful ones
for (let i = 0; i < workers.length; i++) {
    if (results[i].status === "success") {
        await bash({ command: `git merge ${workers[i].branch}` })
    }
}
```

## Fire and forget

```js
// Spawn workers and let them run
spawn("Refactor auth to use JWT")
spawn("Add comprehensive parser tests")
spawn("Update all deprecated API calls")
// Notifications will arrive as each finishes
```

## Selective collection

```js
workers = [
    spawn("Fast task: lint fixes"),
    spawn("Slow task: full test suite refactor"),
    spawn("Medium task: docs update"),
]

// Collect the fast one first
r0 = await workers[0].result

// Check which others are done
done = workers.filter(w => w.status === "done")
still_running = workers.filter(w => w.status === "running")
```

## LLM one-shot (no worktree)

```js
// Quick LLM call — blocking, no tmux
code = await load("src/parser.ts")
review = await llm(`Review this code for bugs:\n\n${code}`, { model: "haiku" })
console.log(review.text)
```

## LLM + workers pipeline

```js
// Use llm() to analyze, then spawn workers for each finding
code = await load("src/")
analysis = await llm(`List the top 3 refactoring opportunities in this codebase: ${[...code.keys()].join(', ')}`)

// Parse findings and spawn workers
tasks = analysis.text.split('\n').filter(l => l.match(/^\d/))
workers = tasks.map(t => spawn(t))
results = await Promise.all(workers.map(w => w.result))
```

## Using pre-defined agents

```js
// Use an agent defined in ~/.pi/agent/agents/scout.md
h = spawn("Find all uses of deprecated APIs", { agent: "scout", model: "haiku" })
r = await h.result
console.log(r.summary)
```

## Cancel a stuck worker

```js
h = spawn("Some task that might hang")
await sleep(60000)  // wait a minute
if (h.status === "running") {
    await h.cancel()
    console.log("Cancelled — worker was taking too long")
}
```

## Attach to watch

```
/spindle list        — see all workers
/spindle attach w0   — jump to w0's tmux session
```

From the tmux session, you see the full pi TUI — every tool call, every edit, real-time.
