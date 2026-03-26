# Sub-Agents

Sub-agents are LLM processes you spawn from the REPL. They have full tool access and return structured episodes.

## `thread()` — the composable primitive

`thread()` creates a lazy spec — the sub-agent doesn't start until consumed. You can store specs in variables, build them from data, and decide when to run them.

```javascript
// Build tasks programmatically from data
files = [...(await load("src/")).keys()].filter(f => f.endsWith(".ts"))
tasks = files.map(f => thread(`Review ${f} for security issues`, { name: f }))

// Run them
results = await dispatch(tasks)
```

### Options

```javascript
thread(task, {
    name: "task-label",   // carried through to episode.name
    agent: "scout",       // named agent from .pi/agents/
    model: "...",         // override model
    tools: ["read"],      // restrict tool access
    timeout: 60000,       // ms
    spindle: true,        // give sub-agent its own REPL
    stepped: true,        // yield intermediate episodes
    fork: true,           // fork current session (inherits conversation context)
    maxDepth: 5,          // override spawn depth limit for this sub-tree (default: 3)
    maxOutput: false,     // disable 50KB output cap
})
```

## `llm()` — convenience for one-shots

`llm()` is sugar for `dispatch([thread(...)])[0]`. Use it when you just need one agent to do one thing.

```javascript
ep = await llm("Summarize src/auth/", { name: "auth-summary" })
console.log(ep.summary)
```

Same options as `thread()` except `stepped`.

## `dispatch()` — parallel execution

Run threads when work is **genuinely independent**. If step 2 depends on what you learned in step 1, use sequential `llm()` calls instead.

Every agent you dispatch has a local view — it can't see what the others are doing and it won't learn from their mistakes. More agents means more local decisions compounding. Prefer fewer, well-scoped agents over broad fan-outs.

```javascript
results = await dispatch(tasks)
```

## Episode Structure

Every sub-agent returns an Episode:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string? | From `opts.name` |
| `status` | string | `"success"`, `"failure"`, `"blocked"`, `"running"` (intermediate only) |
| `summary` | string | One-paragraph description of what happened |
| `findings` | string[] | Key results, discoveries, deliverables |
| `artifacts` | string[] | Files created or modified |
| `blockers` | string[] | What's preventing progress (when blocked) |
| `warnings` | string[] | File collision warnings, memory alerts |
| `output` | string | Full agent response text (truncated to 50KB) |
| `toolCalls` | number | How many tools the agent called |
| `task` | string | The prompt you gave it |
| `agent` | string | Agent config name (or "anonymous") |
| `model` | string | Model used |
| `cost` | number | USD cost |
| `duration` | number | Milliseconds |

## Working With Results

```javascript
// Aggregate
allFindings = results.flatMap(ep => ep.findings)
failures = results.filter(ep => ep.status === "failure")
totalCost = results.reduce((s, ep) => s + ep.cost, 0)

// Summary table
results.forEach(ep => {
    console.log(`${ep.name}: ${ep.status} | $${ep.cost.toFixed(4)} | ${ep.toolCalls} tools | ${(ep.duration/1000).toFixed(0)}s`)
})
```

## When to Dispatch vs Sequential

**Dispatch** when tasks don't need each other's output:
- Review N files independently
- Gather context from N sources
- Apply a well-defined spec to N targets

**Sequential** when each step informs the next:
- Explore → decide → implement → verify
- Anything where round 2's prompt depends on round 1's findings

**Multi-round** when you want both — broad first, then targeted:

```javascript
// Round 1: Broad exploration
scouts = targets.map(t => thread(`Explore ${t.path}`, { name: t.name }))
round1 = await dispatch(scouts)

// Filter for what matters
interesting = round1.filter(ep =>
    ep.findings.some(f => /security|deprecated|critical/i.test(f))
)

// Round 2: Deep dive on the interesting ones only
followups = interesting.map(ep =>
    thread(`Deep dive. Previous findings: ${ep.findings.join("; ")}`, {
        name: `followup-${ep.name}`,
    })
)
round2 = await dispatch(followups)
```

## Stepped Threads

`stepped: true` yields intermediate episodes as the agent works. Use `for await` to observe or bail early.

```javascript
for await (const ep of thread("Refactor auth module", { stepped: true })) {
    console.log(`[${ep.status}] ${ep.summary.slice(0, 80)}`)
    if (ep.status !== "running") break
}
```

## Prompt Discipline

**Short prompts, not stuffed prompts.** Pass paths, not content — sub-agents can read files themselves. Think 200-500 bytes, not 10KB.

```javascript
// ✗ Inlining content
thread(`Analyze this code:\n${fileContent}`, { name: "review" })

// ✓ Pass the path
thread(`Analyze src/auth/login.ts for SQL injection`, { name: "review" })
```

- **Build tasks from data.** `files.map(f => thread(...))` — never hand-write repetitive calls.
- **Name everything.** `{ name: ... }` flows through to `episode.name` and your aggregation code.
- **Scope tightly.** "Review src/auth/login.ts for SQL injection" beats "review the codebase for security issues."

## Discover, Then Dispatch

Discovery results flow directly into dispatch. **Never hand-write a target list that could be derived from a variable.**

```javascript
// ✗ You read ls output and typed this from memory
areas = ["auth", "api", "db"]

// ✓ The variable IS the task list
dirs = (await ls({ path: "src/" })).output.split("\n").filter(d => d.endsWith("/")).map(d => d.slice(0, -1))
tasks = dirs.map(dir => thread(`Explore src/${dir}/`, { name: dir }))
results = await dispatch(tasks)
```

The test: **if you're typing paths that appeared in a previous console.log, you've broken the pipeline.**

## Git Worktrees for Isolation

When parallel agents write code, they collide on files. Spindle detects this (file collision warnings in `episode.warnings`) but doesn't prevent it. Git worktrees solve this — each agent gets its own checkout.

### Setup

```javascript
repoRoot = (await bash({ command: "git rev-parse --show-toplevel" })).output.trim()
currentBranch = (await bash({ command: "git branch --show-current" })).output.trim()
loomDir = `${repoRoot}/.diverge`

// Ensure .diverge/ is gitignored
gitignore = await load(".gitignore")
if (!gitignore.includes(".diverge")) {
    await bash({ command: 'echo ".diverge/" >> .gitignore' })
}

approaches = ["visitor-pattern", "tagged-union", "strategy-obj"]
for (const name of approaches) {
    await bash({ command: `git worktree add ${loomDir}/${name} -b diverge/${name} HEAD` })
}
```

### Dispatch into worktrees

Each agent gets a `cwd` and a clear instruction to work within its worktree:

```javascript
tasks = approaches.map(name => {
    worktree = `${loomDir}/${name}`
    return thread(
        `You are working in: ${worktree}
All file operations must use paths within this directory.
Task: Refactor the AST processor using the ${name} approach.
Run tests: cd ${worktree} && npm test
Commit when done.`,
        { name, spindle: true }
    )
})
results = await dispatch(tasks)
```

Use `spindle: true` — agents working in worktrees typically need to load files, iterate, and run tests.

### Evaluate and merge

```javascript
// Check which branches pass tests
for (const name of approaches) {
    worktree = `${loomDir}/${name}`
    testResult = await bash({ command: `cd ${worktree} && npm test 2>&1` })
    diff = await bash({ command: `cd ${worktree} && git diff ${currentBranch} --stat` })
    console.log(`${name}: ${testResult.ok ? "PASS ✓" : "FAIL ✗"}`)
    console.log(diff.output)
}

// Merge the winner
await bash({ command: `git merge diverge/tagged-union --no-ff -m "merge: tagged-union approach"` })
```

### Cleanup

Always clean up worktrees — they accumulate fast:

```javascript
for (const name of approaches) {
    await bash({ command: `git worktree remove ${loomDir}/${name} --force 2>/dev/null || true` })
    await bash({ command: `git branch -D diverge/${name} 2>/dev/null || true` })
}
```

### When to use worktrees

- **Multiple agents writing code in parallel** — the primary use case
- **Comparing implementation approaches** — see `./diverge.md` for the full pattern
- **Any dispatch where agents modify overlapping files**

Skip worktrees when agents are read-only (reviews, analysis, context gathering) — no collisions possible.
