---
name: repl
description: >
  Persistent JavaScript REPL for tool calls, file I/O, and sub-agent orchestration.
  Use spindle_exec for all operations instead of calling native tools directly.
  Use grep/find/load builtins and JavaScript to search code and manipulate data —
  not bash one-liners. Use for reading/editing files, dispatching parallel sub-agents,
  and scripting multi-step workflows programmatically.
---

# Spindle REPL

> **Deeper topics — read when relevant:**
> - **`./references/subagents.md`** — Dispatching sub-agents, episode structure, multi-round patterns
> - **`./references/patterns.md`** — Common recipes, ToolResult gotchas, session hygiene
> - **`./references/advanced.md`** — Thread communication, barriers, file locking, recursive spindle

A persistent JavaScript environment. Variables survive across calls. Use it to load data, transform it with code, and act on the results.

## When to Use It

The REPL pays off when you need **persistence, iteration, or orchestration** — loading data once and querying it many ways, dispatching sub-agents, chaining multi-step workflows.

**Skip it for one-shot work.** A single `read` to check a file, a quick `bash("npm test")`, a small `edit` — use the native tools directly. Don't wrap everything in `spindle_exec` for the sake of it.

## Workflow: Orient First, Then Act

Start every task by looking at what's there. **Store discovery results in variables — they become your input for the next step.**

```javascript
// Discovery → variable → dispatch. One pipeline, no hand-typing.
dirs = (await ls({ path: "src/" })).output.split("\n").filter(d => d.endsWith("/")).map(d => d.slice(0, -1))
tasks = dirs.map(d => thread(`Explore src/${d}/`, { name: d }))
results = await dispatch(tasks)
```

**The anti-pattern:** running `ls` or `find`, reading the output, then hand-writing an array of targets based on what you saw. If you're typing file paths that appeared in a previous console.log, you've broken the pipeline. The data is *already in a variable* — use it.

## Core Principle: Think in JavaScript

You have `load()`, `find()`, `grep()`, and `ls()` as structured builtins that return data you can manipulate with JavaScript. Use them instead of piping bash commands together.

```javascript
// ✗ WRONG — bash for data extraction
await bash({ command: "find src -name '*.ts' | xargs grep 'export class' | awk -F: '{print $1}' | sort -u" })

// ✓ RIGHT — builtins + JS
hits = await grep({ pattern: "export class", path: "src/" })
classes = hits.output.split("\n").map(line => {
    m = line.match(/^(.+?):.*export class (\w+)/)
    return m ? { file: m[1], name: m[2] } : null
}).filter(Boolean)
```

**When bash IS right:** Builds, tests, git, package managers — tools that *do things*.

```javascript
await bash({ command: "npm test" })
await bash({ command: "git log --oneline -10" })
```

## Essential Rules

**Scoping.** `const`, `let`, `var`, and bare assignments all persist across calls. Destructuring declarations (`const { a, b } = ...`, `const [x, y] = ...`) are the exception — use bare assignment for those: `({ a, b } = obj)`.

**Context budget.** Output is truncated to 8192 chars. Don't dump raw data — store it in a variable and `console.log` only what you need. Use `load()` to read into variables without entering context.

## Builtins

All return `ToolResult { output, error, ok, exitCode }`. Check `.ok` for success.

### Search & Navigate

```javascript
hits = await grep({ pattern: "TODO", path: "src/" })     // recursive search
files = await find({ pattern: "*.test.ts", path: "src/" }) // find by glob
entries = await ls({ path: "src/" })                       // list directory
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
await save("docs/report.md", content) // write without entering context
```

`load()` on a directory reads all files recursively (10MB cap). Target specific subdirectories to control scope. See `./references/patterns.md` for the load-once-query-many workflow.

### Shell

For builds, tests, git — tools that *do things*, not data extraction.

```javascript
result = await bash({ command: "npm test" })
if (!result.ok) console.log("failed:", result.error)
```

## Sub-Agents

`llm()` runs one sub-agent. `thread()` creates a spec. `dispatch()` runs specs in parallel. All return Episodes.

```javascript
files = [...(await load("src/")).keys()].filter(f => f.endsWith(".ts"))
tasks = files.map(f => thread(`Review ${f} for security issues`, { name: f }))
results = await dispatch(tasks)
results.forEach(ep => console.log(`${ep.name}: ${ep.status}`))
```

**Build tasks programmatically** from data. Never hand-write similar `thread()` calls. **Pass paths, not content** — sub-agents can read files themselves. Prompts are capped at 10KB.

For episode structure, options, multi-round patterns, and working with results → **`./references/subagents.md`**

## Utilities

```javascript
await sleep(2000)                                   // async delay
diff("old.ts", "new.ts")                            // unified diff (files or strings)
await retry(() => llm("..."), { attempts: 5 })       // exponential backoff
vars()                                               // list persistent REPL variables
clear("bigData")                                     // free memory
help()                                               // list all builtins
```

## Script Execution

```javascript
spindle_exec({ file: "workflows/audit.spindle.js" })    // runs in same REPL context
```
