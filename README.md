# Spindle

Agent orchestration extension for [pi](https://github.com/mariozechner/pi). Gives the LLM a persistent JavaScript REPL where sub-agents are callable functions, parallel work is dispatched, and workflows are stored as `.spindle.js` scripts that can be linted, reviewed, re-run, and shared.

Based on ideas from [Recursive Language Models](https://arxiv.org/abs/2512.24601) (persistent REPL with variables instead of context stuffing) and [Slate](https://randomlabs.ai/blog/slate) (thread weaving with episode-based checkpoints).

## Install

```bash
# Install as a pi package (extension + skills auto-discovered)
pi install /path/to/spindle

# Or load directly
pi --extension /path/to/spindle/src/index.ts
```

## Script plans

Workflows are `.spindle.js` files — real JavaScript that calls `llm()`, `dispatch()`, and `thread()`. The LLM writes them, you review them, anyone can re-run them.

```javascript
// refactor-auth.spindle.js

// Phase 1: Create shared types (must complete before consumers update)
ep = await llm("Create shared interfaces in src/types.ts", { name: "types" })
if (ep.status !== "success") { console.log("Failed:", ep.summary); return }
await bash({ command: "npm test" })

// Phase 2: Update all consumers in parallel
dirs = (await ls({ path: "src/" })).output.split("\n")
    .filter(d => d.endsWith("/")).map(d => d.slice(0, -1))
tasks = dirs.map(d => thread(`Update src/${d}/ to use new types`, { name: d }))
results = await dispatch(tasks)

// Phase 3: Verify
await bash({ command: "npm test" })
console.log(results.map(r => `${r.name}: ${r.status}`).join("\n"))
```

Run it:

```
/spindle run refactor-auth.spindle.js
```

Lint it first:

```bash
node bin/lint-plan.mjs refactor-auth.spindle.js
```

The linter catches syntax errors (nested backticks), oversized prompts, missing agent names, missing error gates, and missing verification steps — before you spend money on sub-agents.

Scripts are paired with a companion `.md` that captures design rationale — the *why* that doesn't belong in code. The `.spindle.js` is the execution; the `.md` is the orientation.

## Programmatic tool calling

Tools are functions in a persistent REPL. Variables survive across calls. Load data once, query it many ways.

```javascript
// Load an entire directory into a variable (bypasses context window)
src = await load("src/")

// Query it programmatically — no re-reading, no tool calls
exports = [...src.entries()].flatMap(([file, content]) =>
    [...content.matchAll(/export function (\w+)/g)].map(m => ({ file, fn: m[1] }))
)
console.log(exports.length + " exported functions")

// Find unused exports (cross-reference in JS, not grep pipes)
unused = exports.filter(({ fn, file }) =>
    ![...src.entries()].some(([f, c]) => f !== file && c.includes(fn))
)
```

## Parallel sub-agents

Discover targets from the filesystem, dispatch scouts in parallel, aggregate results.

```javascript
// Discovery drives dispatch — no hand-typed file lists
dirs = (await ls({ path: "src/" })).output.split("\n")
    .filter(d => d.endsWith("/")).map(d => d.slice(0, -1))

tasks = dirs.map(d => thread(`Review src/${d}/ for security issues`, { name: d }))
results = await dispatch(tasks)

// Structured results: status, summary, findings, artifacts, cost, duration
critical = results.flatMap(ep => ep.findings).filter(f => /critical/i.test(f))
failures = results.filter(r => r.status !== "success")
totalCost = results.reduce((s, r) => s + r.cost, 0)
```

## Multi-round dispatch

Scout broadly, then follow up on what matters.

```javascript
// Round 1: Explore
scouts = dirs.map(d => thread(`Analyze src/${d}/ for deprecated APIs`, { name: d }))
round1 = await dispatch(scouts)

// Round 2: Fix only what needs fixing
needsWork = round1.filter(ep => ep.findings.length > 0)
fixes = needsWork.map(ep =>
    thread(`Fix deprecated APIs. Findings: ${ep.findings.join("; ")}`, { name: `fix-${ep.name}` })
)
round2 = await dispatch(fixes)
```

## Thread communication

Threads can exchange messages and synchronize via barriers:

```javascript
results = await dispatch([
    thread("Define types, then broadcast to the team", { spindle: true }),
    thread("Wait for types from rank 0, then implement the API", { spindle: true }),
    thread("Wait for types from rank 0, then write the tests", { spindle: true }),
], { communicate: true })
```

## Stepped threads

Watch a long-running agent work and intervene if needed:

```javascript
for await (const ep of thread("Refactor auth module", { stepped: true })) {
    console.log(`[${ep.status}] ${ep.summary.slice(0, 80)}`)
    if (ep.status !== "running") break
}
```

## Commands

| Command | Purpose |
|---|---|
| `/spindle run <file.spindle.js>` | Execute a script plan in the REPL |
| `/spindle <task>` | Prime the model for orchestration |
| `/spindle reset` | Fresh REPL context |
| `/spindle config subModel <model>` | Set default sub-agent model |
| `/spindle status` | Show variables, usage, config |

## Skills

Bundled skills (auto-discovered via pi package):

| Skill | Purpose |
|---|---|
| `repl` | Core REPL usage, builtins, patterns |
| `script-plan` | Writing `.spindle.js` plans with companion docs |
| `script-cycle` | Executing plans, handling failures, reporting |

## Documentation

- **[API Reference](docs/api.md)** — built-in tools, file I/O, sub-agents, threads, communication, episodes
- **[Architecture](docs/architecture.md)** — source layout and design decisions
- **[Examples](docs/examples.md)** — security audit, coordinated research, stepped threads, recursive spindle

## License

MIT
