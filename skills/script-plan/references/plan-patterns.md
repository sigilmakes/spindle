# Plan Patterns

Common shapes for executable plans. Mix and match — most real plans combine several patterns.

## Sequential Pipeline

Each phase depends on the one before it. Gate on success.

```javascript
// Phase 1
ep1 = await llm("Create the interface definitions", { name: "interfaces" })
if (ep1.status !== "success") { console.log("Failed:", ep1.summary); return }

// Phase 2 (depends on phase 1)
ep2 = await llm("Implement the interface from phase 1", { name: "implement" })
if (ep2.status !== "success") { console.log("Failed:", ep2.summary); return }

// Phase 3 (depends on phase 2)
ep3 = await llm("Write tests for the implementation", { name: "tests" })
```

Use when: migrations, refactors where order matters, any chain with data dependencies.

## Fan-Out

Discover targets, dispatch in parallel, aggregate results.

```javascript
dirs = (await ls({ path: "src/" })).output.split("\n")
    .filter(d => d.endsWith("/")).map(d => d.slice(0, -1))

tasks = dirs.map(d => thread(`Refactor src/${d}/ to use the new API`, { name: d }))
results = await dispatch(tasks)

failures = results.filter(r => r.status !== "success")
console.log(`${results.length - failures.length}/${results.length} succeeded`)
```

Use when: independent file/module updates, parallel reviews, broad codebase changes.

## Foundation + Fan-Out

Sequential foundation phase, then parallel work that depends on it.

```javascript
// Foundation: create shared types (must complete first)
ep = await llm("Define shared types in src/types.ts", { name: "types" })
if (ep.status !== "success") return

// Fan-out: update all consumers in parallel
consumers = (await grep({ pattern: "from.*old-types", path: "src/" }))
    .output.split("\n").map(l => l.split(":")[0]).filter(Boolean)
consumers = [...new Set(consumers)]

tasks = consumers.map(f => thread(
    `Update ${f} to use the new types from src/types.ts`,
    { name: f }
))
results = await dispatch(tasks)

await bash({ command: "npm test" })
```

Use when: most refactors. The pattern is: change the interface, then update all consumers.

## Scout → Filter → Execute

Two-round dispatch: broad exploration first, targeted work second.

```javascript
// Round 1: Scout
dirs = (await ls({ path: "src/" })).output.split("\n")
    .filter(d => d.endsWith("/")).map(d => d.slice(0, -1))
scouts = dirs.map(d => thread(`Analyze src/${d}/ for deprecated API usage`, { name: d }))
round1 = await dispatch(scouts)

// Filter: only act on modules with findings
needsWork = round1.filter(ep => ep.findings.length > 0)
console.log(`${needsWork.length}/${round1.length} modules need updates`)

// Round 2: Fix
fixTasks = needsWork.map(ep => thread(
    `Fix deprecated API usage in the module you previously analyzed.
Previous findings: ${ep.findings.join("; ")}`,
    { name: `fix-${ep.name}` }
))
round2 = await dispatch(fixTasks)
```

Use when: you don't know the scope of work upfront. Exploration determines the workload.

## Conditional Branching

Different paths based on what you find.

```javascript
// Check current state
testResult = await bash({ command: "npm test 2>&1" })
hasTypes = (await bash({ command: "test -f src/types.ts && echo yes || echo no" }))
    .output.trim() === "yes"

if (!hasTypes) {
    // Path A: types don't exist yet — create them
    ep = await llm("Create src/types.ts with shared interfaces", { name: "create-types" })
    if (ep.status !== "success") return
} else {
    // Path B: types exist — just verify they're correct
    ep = await llm("Review src/types.ts, fix any issues", { name: "verify-types" })
}

// Continue with common path...
```

Use when: resuming interrupted plans, handling different codebase states.

## Stepped Monitoring

Use `stepped: true` for long-running tasks where you want visibility.

```javascript
for await (const ep of thread("Large refactor of auth module", { stepped: true })) {
    console.log(`[${ep.status}] ${ep.summary.slice(0, 100)}`)
    
    // Bail early if going off track
    if (ep.findings.some(f => /deleting|removing/i.test(f))) {
        console.log("Agent is deleting things — stopping")
        break
    }
}
```

Use when: expensive tasks where you want to intervene if something goes wrong.
