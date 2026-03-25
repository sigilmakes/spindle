# Spindle

Agent orchestration extension for [pi](https://github.com/mariozechner/pi). Gives the LLM a persistent JavaScript REPL where sub-agents are callable functions, parallel work is dispatched, and workflows are stored as `.spindle.js` scripts that can be linted, reviewed, re-run, and shared.

Based on ideas from [Recursive Language Models](https://arxiv.org/abs/2512.24601) (persistent REPL with variables instead of context stuffing) and [Slate](https://randomlabs.ai/blog/slate) (thread weaving with episode-based checkpoints).

## Install

```bash
# Install the CLI globally
npm install -g /path/to/spindle

# Register the extension + skills with pi
pi install /path/to/spindle
```

This gives you:
- **`spindle` CLI** — `spindle run`, `spindle lint`, `spindle new` from the terminal
- **REPL tools** — `spindle_exec` and `spindle_status` inside pi sessions
- **Skills** — `repl`, `script-plan`, `script-cycle` loaded automatically

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

## MCP (Model Context Protocol)

Call external services through MCP servers — Linear, Chrome DevTools, documentation APIs, anything with an MCP interface. Powered by [mcporter](https://github.com/steipete/mcporter).

```javascript
// Discover what's available
await mcp()                        // list servers
await mcp("linear")                // list tools

// One-shot call
result = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })

// Persistent proxy — connection pooled, camelCase methods
linear = await mcp_connect("linear")
await linear.createIssue({ title: "Bug", team: "ENG" })
docs = await linear.searchDocumentation({ query: "API" })
console.log(docs.text())
```

Config: `~/.pi/agent/mcp.json` — same `mcpServers` format as Cursor/Claude/VS Code.

## Spawn depth limits

Sub-agents with `{ spindle: true }` can dispatch further sub-agents. Recursion is capped at a configurable depth (default: 3) to prevent runaway spawning.

```javascript
// Override for a specific sub-tree
thread("complex task", { spindle: true, maxDepth: 5 })
```

At the limit, `llm()`/`thread()`/`dispatch()` throw an error. All other builtins still work.

Configure: `/spindle config maxDepth <N>` or `SPINDLE_MAX_DEPTH` env var.

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

## CLI

Spindle ships a standalone CLI. Link it globally with `npm link` from the spindle directory.

```bash
spindle new refactor-auth              # Scaffold a .spindle.js with phases, gates, and discovery
spindle lint refactor-auth.spindle.js  # Catch syntax errors, missing names, oversized prompts
spindle run refactor-auth.spindle.js   # Lint, then execute via pi
spindle run plan.spindle.js --model claude-sonnet-4-5 --no-lint
```

`new` generates a ready-to-edit skeleton with discovery-driven dispatch, error gates, verification, and cost tracking already wired in. `lint` validates before you spend money on sub-agents. `run` lints first by default, then delegates to pi for execution.

## Pi commands

| Command | Purpose |
|---|---|
| `/spindle run <file.spindle.js>` | Execute a script plan in the REPL |
| `/spindle <task>` | Prime the model for orchestration |
| `/spindle reset` | Fresh REPL context |
| `/spindle config subModel <model>` | Set default sub-agent model |
| `/spindle config maxDepth <N>` | Set max spawn depth (default: 3) |
| `/spindle status` | Show variables, usage, config |

## Skills

Three skills are bundled and auto-discovered via the pi package. They load on-demand — the agent only reads what's relevant to the current task.

**`repl`** — Core REPL usage. Covers the orient-first workflow (look before you dispatch), builtins (`grep`, `find`, `load`, `ls`), essential rules (scoping, context budget), and the sub-agent API (`llm`, `thread`, `dispatch`). References drill into sub-agent orchestration patterns, common recipes, and advanced topics (thread communication, barriers, file locking). Start here.

**`script-plan`** — Writing `.spindle.js` plans. Covers the two-file pattern (`.spindle.js` for execution, `.md` for rationale), script structure (context → phases → verification), string quoting pitfalls, the linter, and what doesn't belong in a script. References cover common plan shapes: sequential pipelines, fan-out, foundation + fan-out, scout → filter → execute, conditional branching, and stepped monitoring.

**`script-cycle`** — Executing plans. Covers the full cycle: lint → orient → execute → handle failures → report. Includes resumption strategies (idempotent phases vs. section commenting), common failure modes with fixes, and auto-generating reports from episode data.

```
skills/
  repl/
    SKILL.md                      ← Start here
    references/
      subagents.md                ← Dispatch, episodes, multi-round, prompt discipline
      patterns.md                 ← Load→query, ToolResult gotchas, variable hygiene
      advanced.md                 ← Comm, barriers, locking, recursive spindle
  script-plan/
    SKILL.md                      ← Writing executable plans
    references/
      plan-patterns.md            ← Sequential, fan-out, scout→fix, stepped
  script-cycle/
    SKILL.md                      ← Running plans, error recovery, reporting
```

## Documentation

- **[API Reference](docs/api.md)** — built-in tools, file I/O, sub-agents, threads, communication, episodes
- **[Architecture](docs/architecture.md)** — source layout and design decisions
- **[Examples](docs/examples.md)** — security audit, coordinated research, stepped threads, recursive spindle

## License

MIT
