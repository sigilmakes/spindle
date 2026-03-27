# Orchestration Patterns

## Data-driven parallelism

Discover targets programmatically, spawn workers from the list:

```js
// Find modules → spawn reviewers
modules = [...(await load('src/')).keys()].filter(f => f.endsWith('.ts'))
workers = modules.map(f => spawn(`Review ${f} for bugs and style issues`))

// Collect all results
results = await Promise.all(workers.map(w => w.result))

// Filter and act
bugs = results.filter(r => r.findings.some(f => f.includes('bug')))
clean = results.filter(r => r.status === 'success' && r.blockers.length === 0)
```

## Pipeline: analyze then fix

Use `llm()` for analysis, `spawn()` for implementation:

```js
// Phase 1: analyze (blocking — quick, no worktree needed)
code = [...(await load('src/')).entries()].map(([k, v]) => `// ${k}\n${v}`).join('\n')
plan = await llm(`Identify the top 3 refactoring opportunities:\n${code}`)

// Phase 2: implement (async — each in its own worktree)
tasks = plan.text.split('\n').filter(l => l.match(/^\d/))
workers = tasks.map(t => spawn(t))
```

## Spawn and continue

The main agent doesn't block — it keeps working while workers run:

```js
// Call 1: spawn
h = spawn("Add comprehensive tests for the parser")

// Call 2: agent does other work with normal tools
// (read, edit, bash — outside the REPL)

// Call 3: collect when ready
r = await h.result
if (r.status === "success") {
    await bash({ command: `git merge ${h.branch}` })
}
```

## Selective collection

Don't wait for everything — collect as results arrive:

```js
workers = [
    spawn("Fast: lint fixes"),
    spawn("Slow: full refactor"),
    spawn("Medium: update docs"),
]

// Poll for completion
while (workers.some(w => w.status === "running")) {
    await sleep(5000)
    for (const w of workers) {
        if (w.status === "done") {
            console.log(`${w.id} finished`)
        }
    }
}
```

## Using pre-defined agents

Agents in `~/.pi/agent/agents/*.md` can be referenced by name:

```js
// scout.md has tools: read, grep, find, ls and model: haiku
h = spawn("Find all deprecated API usages", { agent: "scout" })
```

## Error handling

```js
r = await h.result
if (r.status === "failure") {
    console.log("Failed:", r.summary)
    if (r.blockers.length > 0) {
        console.log("Blockers:", r.blockers.join(", "))
    }
    // Worktree is preserved — can inspect the partial work
    console.log("Inspect:", h.worktree)
}
```
