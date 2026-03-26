---
name: repl
description: >
  Persistent JavaScript REPL with pi tools, MCP integration, and sub-agent
  orchestration. Use when you need persistence, tool chaining, MCP calls, or
  focused sub-agents.
---

# Spindle REPL

> **Deeper topics — read when relevant:**
> - **`./references/subagents.md`** — Thread options, episode structure, multi-round patterns
> - **`./references/patterns.md`** — Common recipes, ToolResult gotchas, session hygiene
> - **`./references/advanced.md`** — Thread communication, barriers, file locking, recursive spindle
> - **`./references/diverge.md`** — Forked exploration: parallel agents on the same problem

A persistent JavaScript environment with pi tools, MCP access, and sub-agent orchestration. Variables survive across calls.

## When to Use It

**Persistence and chaining.** Load data once, query it many ways. Chain tool calls with JS logic between them.

**MCP.** Call external services — issue trackers, documentation APIs, browser automation — programmatically.

**Focused sub-agents.** Spawn a `thread()` for a specific job: review a file, implement a spec, gather context. Not swarms — targeted work.

**Skip it for one-shot work.** A single `read`, a quick `bash("npm test")`, a small `edit` — use native tools directly.

## Core Principle: Think in JavaScript

Use `load()`, `find()`, `grep()`, `ls()` as structured builtins, then transform with JS. Reserve `bash` for builds, tests, git — tools that *do things*.

```javascript
// ✓ builtins + JS
hits = await grep({ pattern: "export class", path: "src/" })
classes = hits.output.split("\n").map(line => {
    m = line.match(/^(.+?):.*export class (\w+)/)
    return m ? { file: m[1], name: m[2] } : null
}).filter(Boolean)

// ✓ bash for builds/tests
await bash({ command: "npm test" })
```

## Essential Rules

**Scoping.** `const`, `let`, `var`, and bare assignments all persist across calls. Destructuring declarations are the exception — use bare assignment: `({ a, b } = obj)`.

**Context budget.** Output truncated to 8192 chars. Store large data in variables, `console.log` only what you need. Use `load()` to read into variables without entering context.

## Builtins

All tool builtins return `ToolResult { output, error, ok, exitCode }`.

### Search & Navigate

```javascript
hits = await grep({ pattern: "TODO", path: "src/" })
files = await find({ pattern: "*.test.ts", path: "src/" })
entries = await ls({ path: "src/" })
```

### Read & Write

```javascript
await read({ path: "src/foo.ts" })
await edit({ path: "src/foo.ts", oldText: "old", newText: "new" })
await write({ path: "out.md", content: report })
```

### File I/O (Context-Free)

Data goes into a variable, not the context window.

```javascript
data = await load("src/auth/")       // directory → Map<path, content>
text = await load("config.json")     // file → string
await save("docs/report.md", content)
```

### Shell

```javascript
result = await bash({ command: "npm test" })
if (!result.ok) console.log("failed:", result.error)
```

## MCP (Model Context Protocol)

Call external services through MCP servers. Powered by mcporter, lazy-loaded on first use.

```javascript
// Discovery
await mcp()                                    // list servers
await mcp("linear")                            // list tools
await mcp("linear", { schema: true })          // include schemas

// One-shot call
result = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })

// Persistent proxy — connection pooled, camelCase, schema-validated
linear = await mcp_connect("linear")
await linear.createIssue({ title: "Bug", team: "ENG" })
docs = await linear.searchDocumentation({ query: "API" })
console.log(docs.text())                       // .text(), .json(), .markdown()

await mcp_disconnect("linear")                 // cleanup
```

Config: `~/.pi/agent/mcp.json` — standard `mcpServers` format.

## Sub-Agents

### `thread()` — the composable primitive

`thread()` creates a lazy spec you can store, compose, and dispatch. The sub-agent doesn't start until consumed.

```javascript
// Build tasks programmatically from data
files = [...(await load("src/")).keys()].filter(f => f.endsWith(".ts"))
tasks = files.map(f => thread(`Review ${f} for security issues`, { name: f }))
results = await dispatch(tasks)

// Consume one at a time with for-await
for await (const ep of thread("refactor auth module", { stepped: true })) {
    console.log(`[${ep.status}] ${ep.summary}`)
    if (ep.status !== "running") break
}
```

### `llm()` — convenience for one-shots

```javascript
ep = await llm("Summarize the auth module", { name: "auth-summary" })
console.log(ep.summary)
```

`llm()` is sugar for `dispatch([thread(...)])[0]`.

### `dispatch()` — parallel execution

```javascript
results = await dispatch(tasks)
results.forEach(ep => console.log(`${ep.name}: ${ep.status}`))
```

Use dispatch when tasks are **genuinely independent**. If step 2 depends on step 1, just use sequential `llm()` calls.

### Episodes

Every thread returns an `Episode`:

```
{ name, status, summary, findings[], artifacts[], blockers[], output, cost, duration }
```

**Pass paths, not content** — sub-agents can read files themselves. Prompts are capped at 10KB.

For options, multi-round patterns, and episode details → **`./references/subagents.md`**

## Spawn Depth Limits

Sub-agents with spindle can dispatch further sub-agents, capped at a configurable depth (default: 3).

```javascript
thread("complex task", { spindle: true, maxDepth: 5 })  // override for a sub-tree
```

At the limit, `llm()`/`thread()`/`dispatch()` throw an error. Everything else still works.

Configure: `/spindle config maxDepth <N>` or `SPINDLE_MAX_DEPTH` env var.

## Utilities

```javascript
await sleep(2000)                                   // async delay
diff("old.ts", "new.ts")                            // unified diff
await retry(() => llm("..."), { attempts: 5 })       // exponential backoff
vars()                                               // list persistent variables
clear("bigData")                                     // free memory
help()                                               // all builtins
```

## Script Execution

```javascript
spindle_exec({ file: "workflows/audit.spindle.js" })    // runs in same REPL context
```
