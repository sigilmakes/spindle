# Sub-Agent Orchestration

Spindle sub-agents are LLM processes you spawn from the REPL. They have full tool access, return structured episodes, and run in parallel.

## The Basics

`llm(prompt, opts?)` — one-shot sub-agent, returns a single Episode.
`thread(task, opts?)` — creates a lazy ThreadSpec (no work until iterated or dispatched).
`dispatch(specs, opts?)` — runs ThreadSpecs in parallel, returns Episode[].

```javascript
// One agent
ep = await llm("Summarize src/auth/", { name: "auth-summary" })

// Many agents in parallel
tasks = files.map(f => thread(`Review ${f}`, { name: f, agent: "scout" }))
results = await dispatch(tasks)
```

### Options

```javascript
llm(prompt, {
    name: "task-label",   // carried through to episode.name
    agent: "scout",       // named agent from .pi/agents/
    model: "...",         // override model
    tools: ["read"],      // restrict tool access
    timeout: 60000,       // ms
    spindle: true,        // give sub-agent its own REPL
    fork: true,           // fork current session (sub-agent inherits conversation context)
    maxDepth: 5,          // override spawn depth limit for this sub-tree (default: 3)
    maxOutput: false,     // disable 50KB output cap
})

thread(task, {
    // same options as llm(), plus:
    stepped: true,        // yield intermediate episodes
    fork: true,           // fork current session
})
```

## Episode Structure

Every sub-agent returns an Episode. These are the fields:

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
| `toolCalls` | number | How many tools the agent called — useful for spotting runaway agents |
| `task` | string | The prompt you gave it |
| `agent` | string | Agent config name (or "anonymous") |
| `model` | string | Model used |
| `cost` | number | USD cost |
| `duration` | number | Milliseconds |

## Working With Results

```javascript
// Aggregate across episodes
allFindings = results.flatMap(ep => ep.findings)
failures = results.filter(ep => ep.status === "failure")
totalCost = results.reduce((s, ep) => s + ep.cost, 0)

// Spot runaway agents
overworked = results.filter(ep => ep.toolCalls > 30)

// Summary table
results.forEach(ep => {
    console.log(`${ep.name}: ${ep.status} | $${ep.cost.toFixed(4)} | ${ep.toolCalls} tools | ${(ep.duration/1000).toFixed(0)}s`)
})
```

## Multi-Round Dispatch

The most natural pattern: scout broadly, then follow up on what matters.

```javascript
// Round 1: Broad exploration
scouts = targets.map(t => thread(`Explore ${t.path}`, { name: t.name }))
round1 = await dispatch(scouts)

// Filter for interesting results
interesting = round1.filter(ep =>
    ep.findings.some(f => /security|deprecated|critical/i.test(f))
)

// Round 2: Deep dive on the interesting ones
followups = interesting.map(ep =>
    thread(`Deep dive on this area. Previous findings: ${ep.findings.join("; ")}`, {
        name: `followup-${ep.name}`,
    })
)
round2 = await dispatch(followups)
```

This beats a single-round broadcast because you steer between rounds. The first wave is cheap recon; the second wave is targeted.

## Sequential With Conditional Logic

Not everything needs parallelism. Use `llm()` in a loop when each step depends on the last.

```javascript
modules = ["auth", "api", "database"]
for (const mod of modules) {
    ep = await llm(`Analyze src/${mod}/`, { name: mod })
    if (ep.status === "failure") { console.log(`${mod}: failed`); continue }
    console.log(`${mod}: ${ep.findings.length} findings`)
}
```

## Stepped Threads

`stepped: true` makes a thread yield intermediate episodes as the agent works. Use `for await` to observe or react mid-flight.

```javascript
for await (const ep of thread("Refactor auth module", { stepped: true })) {
    console.log(`[${ep.status}] ${ep.summary.slice(0, 80)}`)
    if (ep.status !== "running") break
}
```

This is the answer to "I can't steer mid-flight." You see checkpoints as they happen and can break out early if the agent is going off track.

## Discover, Then Dispatch

Discovery results flow directly into dispatch. **Never hand-write a target list that could be derived from a variable.**

```javascript
// ✗ WRONG — ran ls, read the output, then typed this from memory
entries = await ls({ path: "src/" })
console.log(entries.output)  // prints: auth/ api/ db/ utils/
// ... next spindle_exec call:
areas = [
    { name: "auth", files: ["src/auth/login.ts", "src/auth/session.ts"] },
    { name: "api", files: ["src/api/routes.ts", "src/api/middleware.ts"] },
]  // ← you just typed what you saw. The data was RIGHT THERE.

// ✓ RIGHT — the variable IS the task list
dirs = (await ls({ path: "src/" })).output.split("\n").filter(d => d.endsWith("/")).map(d => d.slice(0, -1))
tasks = dirs.map(dir => thread(`Explore src/${dir}/`, { name: dir }))
results = await dispatch(tasks)
```

For nested structure, build the full picture into a variable first:

```javascript
topDirs = (await ls({ path: "src/" })).output.split("\n").filter(d => d.endsWith("/")).map(d => d.slice(0, -1))
structure = {}
for (const d of topDirs) {
    structure[d] = (await ls({ path: `src/${d}` })).output.split("\n").filter(Boolean)
}
tasks = Object.entries(structure).map(([dir, contents]) =>
    thread(`Explore src/${dir}/. Contains: ${contents.join(", ")}`, { name: dir })
)
results = await dispatch(tasks)
```

The test: **if you're typing file paths or directory names that appeared in a previous console.log, you've broken the pipeline.** That data is already in a variable — transform it, don't transcribe it.

## Prompt Discipline

**Short prompts, not stuffed prompts.** A sub-agent prompt should be a task description + file paths. Think 200-500 bytes, not 10KB. Sub-agents have full tool access — they can read files themselves. When you inline content, large areas get truncated and the sub-agent has to rediscover everything from scratch, making dozens of tool calls. Small areas work but you've wasted prompt space. Either way you lose.

```javascript
// ✗ WRONG — inlining file content into the prompt
tasks = dirs.map(dir => {
    content = areas[dir].map(f => f.content).join("\n")
    return thread(`Analyze this code:\n${content}`, { name: dir })
})

// ✓ RIGHT — pass paths, let the agent read
tasks = dirs.map(dir => {
    files = areas[dir].map(f => f.path).join(", ")
    return thread(`Analyze ${dir}/. Files: ${files}`, { name: dir })
})
```

- **Build tasks from data.** `files.map(f => thread(...))` not hand-written repetitive calls.
- **Name everything.** `{ name: ... }` flows through to `episode.name`, rendering, and your aggregation code.
- **Scope tightly.** "Review src/auth/login.ts for SQL injection" beats "review the codebase for security issues."
