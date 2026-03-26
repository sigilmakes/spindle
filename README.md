# Spindle

A persistent JavaScript REPL extension for [pi](https://github.com/mariozechner/pi). Gives the agent pi tools as callable functions, MCP access to external services, and focused sub-agent orchestration — all in a persistent environment where variables survive across calls.

## Install

```bash
pi install /path/to/spindle
```

This gives you:
- **REPL tools** — `spindle_exec` and `spindle_status` inside pi sessions
- **Skills** — `repl`, `mcp`, `work` loaded automatically
- **CLI** — `spindle run`, `spindle lint`, `spindle new` from the terminal

## The REPL

A persistent JavaScript environment. Load data once, query it many ways. Chain pi tools with JS logic between them.

```javascript
// Load an entire directory into a variable (bypasses context window)
src = await load("src/")

// Query it programmatically — no re-reading, no tool calls
exports = [...src.entries()].flatMap(([file, content]) =>
    [...content.matchAll(/export function (\w+)/g)].map(m => ({ file, fn: m[1] }))
)

// Cross-reference in JS, not grep pipes
unused = exports.filter(({ fn, file }) =>
    ![...src.entries()].some(([f, c]) => f !== file && c.includes(fn))
)
console.log(unused.length + " potentially unused exports")
```

All pi tools are available as functions: `read()`, `bash()`, `grep()`, `find()`, `edit()`, `write()`, `ls()`, `load()`, `save()`.

## MCP (Model Context Protocol)

Call external services through MCP servers — issue trackers, documentation APIs, browser automation. Powered by [mcporter](https://github.com/steipete/mcporter), lazy-loaded on first use.

```javascript
// Discover what's available
await mcp()                        // list servers
await mcp("linear")                // list tools

// One-shot call
result = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })

// Persistent proxy — connection pooled, camelCase methods, schema-validated
linear = await mcp_connect("linear")
await linear.createIssue({ title: "Bug", team: "ENG" })
docs = await linear.searchDocumentation({ query: "API" })
console.log(docs.text())
```

Config: `~/.pi/agent/mcp.json` — same `mcpServers` format as Cursor/Claude/VS Code.

## Sub-Agents

### `thread()` — the composable primitive

`thread()` creates a lazy spec you can store, pass around, and dispatch. The sub-agent doesn't start until consumed.

```javascript
// Build tasks programmatically from data
files = [...(await load("src/")).keys()].filter(f => f.endsWith(".ts"))
tasks = files.map(f => thread(`Review ${f} for security issues`, { name: f }))
results = await dispatch(tasks)

// Structured results
critical = results.flatMap(ep => ep.findings).filter(f => /critical/i.test(f))
totalCost = results.reduce((s, r) => s + r.cost, 0)
```

### `llm()` — convenience for one-shots

```javascript
ep = await llm("Summarize the auth module")
console.log(ep.summary)
```

### `dispatch()` — parallel execution

Run threads when work is genuinely independent. If step 2 depends on step 1, use sequential calls instead.

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

### Stepped threads

Watch a long-running agent work:

```javascript
for await (const ep of thread("Refactor auth module", { stepped: true })) {
    console.log(`[${ep.status}] ${ep.summary.slice(0, 80)}`)
    if (ep.status !== "running") break
}
```

### Thread communication

Threads can exchange messages and synchronize via barriers when needed:

```javascript
results = await dispatch([
    thread("Define types, then broadcast to the team", { spindle: true }),
    thread("Wait for types from rank 0, then implement the API", { spindle: true }),
    thread("Wait for types from rank 0, then write the tests", { spindle: true }),
], { communicate: true })
```

## Spawn Depth Limits

Sub-agents with `{ spindle: true }` can dispatch further sub-agents. Recursion is capped at a configurable depth (default: 3) to prevent runaway spawning.

```javascript
thread("complex task", { spindle: true, maxDepth: 5 })  // override for a sub-tree
```

Configure: `/spindle config maxDepth <N>` or `SPINDLE_MAX_DEPTH` env var.

## Script Plans

Workflows as `.spindle.js` files — real JavaScript that runs in the REPL. Paired with a companion `.md` for design rationale.

```javascript
// refactor-auth.spindle.js

// Phase 1: Create shared types
ep = await llm("Create shared interfaces in src/types.ts", { name: "types" })
if (ep.status !== "success") { console.log("Failed:", ep.summary); return }
await bash({ command: "npm test" })

// Phase 2: Update consumers in parallel
dirs = (await ls({ path: "src/" })).output.split("\n")
    .filter(d => d.endsWith("/")).map(d => d.slice(0, -1))
tasks = dirs.map(d => thread(`Update src/${d}/ to use new types`, { name: d }))
results = await dispatch(tasks)
```

```bash
spindle lint refactor-auth.spindle.js   # catch errors before spending money
spindle run refactor-auth.spindle.js    # lint then execute via pi
spindle new refactor-auth               # scaffold a new plan
```

## Pi Commands

| Command | Purpose |
|---|---|
| `/spindle run <file.spindle.js>` | Execute a script plan in the REPL |
| `/spindle <task>` | Prime the model for orchestration |
| `/spindle reset` | Fresh REPL context |
| `/spindle config subModel <model>` | Set default sub-agent model |
| `/spindle config maxDepth <N>` | Set max spawn depth (default: 3) |
| `/spindle status` | Show variables, usage, config |

## Skills

Three skills bundled and auto-discovered:

**`repl`** — Core REPL usage: builtins, MCP, sub-agents, depth limits. Start here. References drill into sub-agent patterns, common recipes, and advanced topics.

**`mcp`** — MCP server discovery and tool calls.

**`work`** — Autonomous plan execution. Takes a plan, parses tasks, loops sub-agents over them. References cover patterns: ralph loops, ralph-critic, implementer-critic, autoresearch.

## Documentation

- **[API Reference](docs/api.md)** — built-in tools, MCP, sub-agents, threads, episodes
- **[Architecture](docs/architecture.md)** — source layout and design decisions
- **[Examples](docs/examples.md)** — security audit, MCP orchestration, coordinated research, stepped threads

## License

MIT
