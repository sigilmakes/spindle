# Diverge: Forked Exploration

Generate N parallel attempts at the same problem from the same starting point, then pick the winner. LLM stochasticity becomes a feature when you can apply selection pressure to outputs.

Two modes:
- **Conversation diverge** — agents reason about the same question with different strategies. No git isolation. Pick the best episode.
- **Code diverge** — agents write code in isolated git worktrees. Evaluation is automated (tests, benchmarks). Winner gets merged.

Start with conversation diverge to narrow options cheaply, then code-diverge the top contenders.

## When to Diverge

Diverging costs N× a single attempt. Use it when:

- **Multiple viable approaches exist** and you don't know which is best
- **Evaluation is cheap relative to generation** — running tests is fast, writing code is slow
- **You'd iterate anyway** — diverging does all the tries in parallel instead of sequentially
- **The wrong choice is expensive to reverse** — architecture, core data model, performance strategy

Skip it when:
- The task has one obvious approach
- The task is trivial or mechanical
- You can't articulate at least 2 distinct strategies
- You'd need more than 5 branches (narrow the problem first)

| Branches | When |
|----------|------|
| **2** | Clear A/B comparison — two known strategies |
| **3** | Default — good diversity, manageable cost |
| **5** | Conversation diverge only (cheap), or highly diverse strategies |

## Conversation Diverge

The lightweight mode. Dispatch N agents with the same question, different framings. No worktrees, no git — just parallel reasoning.

### Pure Stochasticity

Same prompt, N attempts. Randomness does the forking:

```javascript
task = "Design the error handling strategy for src/api/. Read the code first."
tasks = Array.from({ length: 3 }, (_, i) =>
    thread(task, { name: `attempt-${i}` })
)
results = await dispatch(tasks)

results.forEach(ep => {
    console.log(`${ep.name}: ${ep.status} | ${ep.findings.length} findings`)
})
```

Even identical prompts produce meaningfully different outputs. One agent might focus on retry logic, another on circuit breakers, a third on error classification.

### Seeded Strategies

When you know the design space, seed each agent with a different perspective:

```javascript
question = "How should we handle auth for the new API?"

strategies = [
    { name: "security-first", seed: "Approach from a security-first perspective. Most secure design, note usability tradeoffs." },
    { name: "simplicity-first", seed: "Approach from a simplicity-first perspective. Simplest design that meets requirements, note security risks." },
    { name: "evolution-first", seed: "Approach from an evolvability perspective. Most room to change our minds later." },
]

tasks = strategies.map(s =>
    thread(`${question}\n\nStrategy: ${s.seed}`, { name: s.name })
)
results = await dispatch(tasks)
```

More directed than stochastic forking — you're exploring a known design space rather than hoping randomness covers it.

### Model Diversity

Different models have different strengths. Fan out across them for structurally different perspectives:

```javascript
models = ["claude-sonnet-4-20250514", "o4-mini", "gemini-2.5-pro"]

task = "Propose a caching strategy for src/db/queries.ts. Read the code first."
tasks = models.map(m =>
    thread(task, { name: m, model: m })
)
results = await dispatch(tasks)
```

### Structured Comparison

Ask agents to output structured reasoning so comparison is easier:

```javascript
STRUCTURED_SUFFIX = `

Structure your response:
1. **Proposed design** — core approach in 2-3 sentences
2. **Advantages** — what this gets right
3. **Risks** — what could go wrong
4. **Migration path** — how to get from here to there
5. **Confidence** — high/medium/low and key dependencies`

tasks = strategies.map(s =>
    thread(`${question}\n\n${s.seed}${STRUCTURED_SUFFIX}`, { name: s.name })
)
results = await dispatch(tasks)
```

### Debate Pattern

Two agents argue opposing positions. Stress-tests an idea:

```javascript
proposal = "We should migrate from REST to GraphQL for the public API."

tasks = [
    thread(
        `Argue IN FAVOR: "${proposal}"\nMake the strongest case. Address counterarguments. Be specific with examples from src/api/.`,
        { name: "pro" }
    ),
    thread(
        `Argue AGAINST: "${proposal}"\nMake the strongest case. Address pro-arguments. Be specific about risks from src/api/.`,
        { name: "con" }
    ),
]
results = await dispatch(tasks)
```

Read both arguments, then synthesize a decision that accounts for the strongest points from each side.

### Hypothesis Testing (Debugging)

When a bug has multiple plausible causes, investigate each in parallel:

```javascript
bug = "API responses are intermittently slow (p99 jumped from 200ms to 2s)"

hypotheses = [
    { name: "db-queries", prompt: `Investigate slow database queries — N+1, missing indexes, pool exhaustion. Symptom: ${bug}` },
    { name: "memory-leak", prompt: `Investigate memory leak causing GC pauses — growing allocations, unclosed streams. Symptom: ${bug}` },
    { name: "external-dep", prompt: `Investigate external dependency latency — timeout configs, retry logic. Symptom: ${bug}` },
]

tasks = hypotheses.map(h => thread(h.prompt, { name: h.name }))
results = await dispatch(tasks)

results.forEach(ep => {
    evidence = ep.findings.length > 0 ? "EVIDENCE FOUND" : "no evidence"
    console.log(`${ep.name}: ${evidence}`)
    ep.findings.forEach(f => console.log(`  → ${f}`))
})
```

### Picking the Winner

For small diverges (2-3 candidates), reading the summaries yourself is often faster and better than a judge agent. For larger ones:

```javascript
summaries = results.map(ep =>
    `## ${ep.name}\n${ep.summary}\n\nFindings:\n${ep.findings.map(f => `- ${f}`).join("\n")}`
).join("\n\n---\n\n")

judge = await llm(
    `Evaluate ${results.length} competing approaches:\n\n${summaries}\n\n` +
    `Pick the best one. Explain why. Last line: WINNER: <name>`,
    { name: "judge", tools: [] }
)

winnerName = judge.output.match(/WINNER:\s*(.+)/)?.[1]?.trim()
winner = results.find(ep => ep.name === winnerName)
```

Restrict the judge's tools to `[]` — it should evaluate, not explore.

## Code Diverge

When agents need to write and test code, they need isolation. Git worktrees give each agent its own checkout — no file collisions, no coordination needed.

### Phase 1: Setup Worktrees

```javascript
// Verify clean state
status = (await bash({ command: "git status --porcelain" })).output.trim()
if (status) { console.log("Dirty tree. Commit or stash first."); return }

currentBranch = (await bash({ command: "git branch --show-current" })).output.trim()
repoRoot = (await bash({ command: "git rev-parse --show-toplevel" })).output.trim()
loomDir = `${repoRoot}/.diverge`

// Ensure .diverge/ is gitignored
gitignore = await load(".gitignore")
if (!gitignore.includes(".diverge")) {
    await bash({ command: 'echo ".diverge/" >> .gitignore' })
}

approaches = [
    { name: "visitor-pattern", prompt: "Refactor using the visitor pattern. Focus on extensibility." },
    { name: "tagged-union", prompt: "Refactor using tagged unions with exhaustive matching." },
    { name: "strategy-obj", prompt: "Refactor using strategy objects with a registry." },
]

// Create worktree + branch for each approach
for (const a of approaches) {
    branch = `diverge/${a.name}`
    worktree = `${loomDir}/${a.name}`
    await bash({ command: `git worktree add ${worktree} -b ${branch} HEAD` })
}
```

### Phase 2: Dispatch Agents

Each agent gets its worktree path and a distinct strategy hint. Strategy diversity is the whole point — if your hints are too similar, you're wasting branches.

```javascript
// ✗ Too similar — all three will converge
strategies = ["Optimize the function", "Make it faster", "Improve performance"]

// ✓ Genuinely different approaches
strategies = ["Hash map lookup", "Result caching with invalidation", "Restructure data model"]
```

The dispatch:

```javascript
TASK = "Refactor the AST processor in src/compiler/ast.ts"

tasks = approaches.map(a => {
    worktree = `${loomDir}/${a.name}`
    return thread(
        `You are working in a git worktree at: ${worktree}
All file operations must use paths within ${worktree}.

Task: ${TASK}
Strategy: ${a.prompt}

Requirements:
- cd into ${worktree} before any work
- Make changes, run tests: cd ${worktree} && npm test
- Commit with a descriptive message when done`,
        { name: a.name, spindle: true }
    )
})

results = await dispatch(tasks)
results.forEach(ep => {
    console.log(`${ep.name}: ${ep.status} | $${ep.cost.toFixed(3)} | ${ep.toolCalls} tools`)
})
```

Use `spindle: true` for code diverge agents — they'll typically need to load files, run tests, and iterate.

### Phase 3: Evaluate

Run automated checks across all worktrees:

```javascript
evaluations = []
for (const a of approaches) {
    worktree = `${loomDir}/${a.name}`

    testResult = await bash({ command: `cd ${worktree} && npm test 2>&1` })
    diffStat = await bash({ command: `cd ${worktree} && git diff ${currentBranch} --stat` })
    log = await bash({ command: `cd ${worktree} && git log ${currentBranch}..HEAD --oneline` })

    evaluations.push({
        name: a.name, worktree,
        testsPass: testResult.ok,
        diffStat: diffStat.output,
        log: log.output,
    })
}

evaluations.forEach(e => {
    console.log(`\n--- ${e.name} ---`)
    console.log(`Tests: ${e.testsPass ? "PASS ✓" : "FAIL ✗"}`)
    console.log(`Commits: ${e.log || "(none)"}`)
    console.log(`Diff:\n${e.diffStat}`)
})
```

#### Evaluation strategies

**Test gate** — the minimum bar. Branches that fail are eliminated:

```javascript
passing = evaluations.filter(e => e.testsPass)
```

**Benchmark comparison** — for optimization tasks with a numeric target:

```javascript
BENCH_CMD = "npm run bench"
BENCH_PATTERN = /completed in ([\d.]+)ms/

for (const e of passing) {
    bench = await bash({ command: `cd ${e.worktree} && ${BENCH_CMD} 2>&1` })
    e.benchMs = parseFloat(bench.output.match(BENCH_PATTERN)?.[1] || "Infinity")
}
passing.sort((a, b) => a.benchMs - b.benchMs)
```

**LLM-as-judge** — when quality is qualitative:

```javascript
diffs = await Promise.all(passing.map(async e => {
    d = await bash({ command: `cd ${e.worktree} && git diff ${currentBranch}` })
    return `## ${e.name}\n\`\`\`diff\n${d.output.slice(0, 5000)}\n\`\`\``
}))

judge = await llm(
    `Evaluate ${passing.length} approaches to: "${TASK}"\n\n${diffs.join("\n\n")}\n\n` +
    `Score each on correctness (0-10), maintainability (0-10), elegance (0-10).\n` +
    `State the winner on the last line.`,
    { name: "judge", tools: [] }
)
```

**Present to user** — sometimes the right evaluator is the human:

```javascript
console.log("Diverge complete. Branches ready for review:")
passing.forEach(e => {
    console.log(`  ${e.name}: ${e.worktree}`)
    console.log(`  ${e.diffStat}`)
})
console.log("\nInspect the worktrees and tell me which to merge.")
```

### Phase 4: Merge and Cleanup

```javascript
// Merge the winner
winner = passing[0] // or however you selected
await bash({ command: `git merge diverge/${winner.name} --no-ff -m "diverge: ${TASK} (${winner.name})"` })

// Verify post-merge
finalTests = await bash({ command: "npm test" })
if (!finalTests.ok) {
    console.log("Tests fail after merge. Rolling back.")
    await bash({ command: "git reset --hard HEAD~1" })
    return
}

// Cleanup — ALWAYS, even on failure
for (const a of approaches) {
    await bash({ command: `git worktree remove ${loomDir}/${a.name} --force 2>/dev/null || true` })
    await bash({ command: `git branch -D diverge/${a.name} 2>/dev/null || true` })
}
```

**Clean up on success.** Don't accumulate stale worktrees.
**Leave worktrees on failure.** If no branch passes or the merge fails, keep them for inspection. Clean up manually once diagnosed.

### Branching from Branches

You can diverge from any point in the tree, not just from main. After evaluating your initial branches, you might want to go deeper on a promising approach:

```javascript
// Initial diverge produced 3 branches. Branch "tagged-union" was interesting
// but needs refinement. Diverge again from THAT branch:

parentBranch = "diverge/tagged-union"
subDir = `${loomDir}/tagged-union-refinements`

refinements = [
    { name: "with-validation", prompt: "Add runtime validation to the tagged unions" },
    { name: "with-codegen", prompt: "Add a code generator for the union boilerplate" },
]

for (const r of refinements) {
    await bash({ command: `git worktree add ${subDir}/${r.name} -b diverge/${r.name} ${parentBranch}` })
}

// Dispatch, evaluate, merge — same pattern as above
```

The tree grows from the middle. Each diverge point can spawn further diverges. Keep the depth manageable — two levels is usually enough.

## Composing Diverges

The most powerful pattern: conversation diverge feeds into code diverge. Explore cheaply, then implement the finalists.

```javascript
// Phase 1: Conversation diverge — explore approaches (cheap)
perspectives = [
    "Optimize with algorithmic improvements — better data structures, fewer passes",
    "Optimize with caching and memoization — precompute what you can",
    "Optimize with parallelism — worker_threads or chunked async",
]

phase1 = await dispatch(
    perspectives.map((p, i) => thread(
        `Analyze src/engine/render.ts and propose a concrete optimization plan.\n` +
        `Approach: ${p}\nRead the code. Identify specific changes. Estimate the impact.`,
        { name: `explore-${i}` }
    ))
)

phase1.forEach(ep => {
    console.log(`\n## ${ep.name}\n${ep.summary}`)
    ep.findings.forEach(f => console.log(`  - ${f}`))
})

// Pick top 2 finalists (manually or with a judge)
finalists = [phase1[0], phase1[2]] // algorithmic + parallelism looked best

// Phase 2: Code diverge — implement the finalists (expensive, isolated)
for (const ep of finalists) {
    await bash({ command: `git worktree add ${loomDir}/${ep.name} -b diverge/${ep.name} HEAD` })
}

implTasks = finalists.map(ep => {
    worktree = `${loomDir}/${ep.name}`
    return thread(
        `You are working in a git worktree at: ${worktree}\n` +
        `Implement this optimization plan for src/engine/render.ts:\n${ep.findings.join("\n")}\n\n` +
        `Run tests: cd ${worktree} && npm test\nCommit when done.`,
        { name: ep.name, spindle: true }
    )
})

phase2 = await dispatch(implTasks)

// Evaluate and merge winner — same pattern as above
```

The conversation phase prunes bad ideas before you spend agent time implementing them.

## Practical Notes

**Prompt parity.** Keep prompts identical except for the strategy seed, so you're comparing approach quality, not prompt quality.

**Failed branches are data.** A branch that fails tells you something about that approach's viability. Include failure analysis in your evaluation.

**Cost awareness.** A 3-way code diverge costs ~3× a single agent run. Conversation diverges are much cheaper — agents that only read and think use fewer tokens than agents that write, test, and iterate.

**Worktree hygiene.** The `.diverge/` directory convention keeps worktrees contained. Branch prefix `diverge/` groups them in `git branch` output. Delete both after merging.

```bash
# List active worktrees
git worktree list

# Nuclear cleanup
git worktree list --porcelain | grep "^worktree.*\.diverge" | cut -d' ' -f2 | xargs -I{} git worktree remove {} --force
git branch --list 'diverge/*' | xargs -r git branch -D
git worktree prune
```
