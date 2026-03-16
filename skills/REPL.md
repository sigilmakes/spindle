---
name: repl
description: >
  Persistent JavaScript REPL for tool calls, file I/O, and sub-agent orchestration.
  Use spindle_exec for all operations instead of calling native tools directly.
  Use when running shell commands, reading/editing files, searching code,
  loading directories, dispatching parallel sub-agents, or scripting multi-step
  workflows programmatically.
---

# Spindle REPL

Use `spindle_exec` for all operations. Call `help()` inside the REPL to see available builtins.

## Essential Rules

**Scoping.** Bare assignment (`x = 1`) persists across calls. `const` and `let` are scoped to one call and lost. Use bare assignment for anything you need later.

**Context.** Output is truncated to 8192 chars. Store results in variables; `console.log` only what you need. Prefer `load()` over `read()` — load stores into a variable without entering context.

**Code, not prose.** Use loops, conditionals, and variables to build tasks from data. Don't manually write similar prompts — generate them from an array. Don't paste file contents into prompts — pass file paths and let sub-agents read them.

## Tools

All return `ToolResult { output, error, ok, exitCode }`. Check `.ok` for success. Coerce to string with `${result}` or `.output`.

```javascript
result = await bash({ command: "npm test" })
if (!result.ok) console.log("failed:", result.error)

await read({ path: "src/foo.ts" })
await edit({ path: "src/foo.ts", oldText: "old", newText: "new" })
await write({ path: "out.md", content: report })
await grep({ pattern: "TODO", path: "src/" })
await find({ pattern: "*.ts", path: "src/" })
await ls({ path: "src/" })
```

## File I/O

Bypasses the context window — data goes into a variable, not chat output.

```javascript
data = await load("src/auth/")       // directory → Map<path, content>
text = await load("big-file.json")    // file → string
await save("docs/report.md", content) // write without entering context
```

`load()` reads all files in a directory (no filters, no skipping). The 10MB default cap prevents runaway loads. Target specific paths to control scope.

## Sub-Agents

**Build sub-agent tasks programmatically.** The REPL is a programming environment — use it like one. Load data, loop over it, generate thread prompts from arrays, filter results with code. Never write out 5 similar `thread()` calls by hand.

**Pass pointers, not payloads.** Sub-agents have full tool access. Don't stuff file contents into prompts — pass paths and let the sub-agent read them. Prompts are capped at 10KB.

`llm()` runs one sub-agent. `dispatch()` runs many in parallel. Both return Episodes.

```javascript
// BAD — hand-writing similar threads, stuffing content into prompts
content = await load("src/auth.ts")
ep = await llm(`Review this:\n${content}`)  // wastes context, hits 10KB cap

// GOOD — generate from data, pass paths, name each thread
files = [...(await load("src/")).keys()].filter(f => f.endsWith(".ts"))
tasks = files.map(f => thread(`Review ${f} for security issues`, { name: f, agent: "scout" }))
results = await dispatch(tasks)
results.forEach(ep => console.log(`${ep.name}: ${ep.status} — ${ep.summary.slice(0, 80)}`))
```

```javascript
// Sequential with conditional logic
modules = ["auth", "api", "database"]
for (const mod of modules) {
    ep = await llm(`Analyze the ${mod} module in src/${mod}/`, { name: mod })
    if (ep.status === "failure") { console.log(`${mod} failed`); continue }
    console.log(`${mod}: ${ep.findings.length} findings`)
}
```

**Episode fields:** `name`, `status` (success/failure/blocked), `summary`, `findings[]`, `artifacts[]`, `blockers[]`, `output`, `cost`, `duration`.

### Options

```javascript
llm(prompt, {
    name: "task-label",   // carried through to episode.name
    agent: "scout",       // named agent from .pi/agents/
    model: "...",         // override model
    tools: ["read"],      // restrict tool access
    timeout: 60000,       // ms
    spindle: true,        // give sub-agent its own REPL
    maxOutput: false,     // disable 50KB output cap
})

thread(task, {
    name: "my-thread",   // appears in episode.name and render
    agent: "worker",
    stepped: true,        // yield intermediate episodes
    // ... same options as llm()
})
```

## Utilities

```javascript
await sleep(2000)
diff("old.ts", "new.ts")                       // unified diff (files or strings)
diff(oldStr, newStr, { context: 5 })            // custom context lines
await retry(() => llm("..."), { attempts: 5 })  // exponential backoff
vars()                                          // list persistent REPL variables
clear("bigData")                                // free memory
help()                                          // list all builtins
```

## Script Execution

```javascript
spindle_exec({ file: "workflows/audit.js" })    // runs in same REPL context
```

## Advanced Topics

For thread communication (barriers, send/recv/broadcast), file locking, output limits, and recursive spindle — read `references/advanced.md`.
