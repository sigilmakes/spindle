---
name: repl
description: Persistent JavaScript REPL — the default way to call tools, orchestrate sub-agents, and manage files. All tool calls should go through spindle_exec.
---

# Spindle REPL

**Use `spindle_exec` for all operations.** It has file locking, persistent variables, structured results, and sub-agent orchestration. Do not call native tools (read, edit, write, bash) directly.

**Write code, not walls of text.** Use for loops, conditionals, and variables to build thread tasks programmatically from data you've loaded. Don't manually write out 5 similar thread prompts — generate them from an array. Don't paste file contents into prompts — load them into variables and interpolate. The REPL is a programming environment, use it like one.

Variables persist across `spindle_exec` calls with plain assignment. `const` and `let` are scoped to a single call and will be lost. Output is truncated to 8192 chars — store results in variables, `console.log` only what you need.

## Built-in Tools

All return `ToolResult { output, error, ok, exitCode }`. Never throw — check `.ok` for success. Coerce to string with `${result}` or use `.output` directly.

These have pi's truncation limits (50KB/2000 lines) — use `load()` for full file content.

```javascript
result = await bash({ command: "npm test" })
if (!result.ok) console.log("failed:", result.error)

await edit({ path: "src/foo.ts", oldText: "old", newText: "new" })
await write({ path: "out.md", content: report })
await read({ path: "src/foo.ts" })
await grep({ pattern: "TODO", path: "src/" })
await find({ pattern: "*.ts", path: "src/" })
await ls({ path: "src/" })
```

## File I/O (Bypasses Context)

```javascript
data = await load("src/auth/")       // directory → Map<path, content>
text = await load("big-file.json")    // file → string
await save("docs/report.md", content) // write without entering context
```

**Guard your context window.** Prefer `load()` over `read()` — load stores data in a variable without outputting it. Use `grep`, `bash` with `awk`/`jq`/`head`/`tail` to extract what you need. Only `console.log` the specific lines or values you need to see — never dump entire files or large generated content.

## Sub-Agents

Both `llm()` and `dispatch()` return Episodes with the same structure. Sub-agents are full pi processes with ALL tools (mcp, extensions).

```javascript
// One-shot — returns Episode
ep = await llm("summarize this code: " + code)
console.log(ep.summary)    // structured summary
console.log(ep.output)     // full text output (up to 50KB)
console.log(ep.status)     // success | failure | blocked
console.log(ep.cost)       // dollar cost

// Parallel dispatch — returns Episode[]
results = await dispatch([
    thread("analyze auth module", { agent: "scout" }),
    thread("check test coverage", { agent: "scout" }),
    thread("find security issues", { agent: "scout" }),
])

for (const ep of results) {
    console.log(ep.status, ep.summary)
    console.log(ep.findings)
}
```

### Build Thread Tasks Programmatically

**Never write out multiple similar thread() calls by hand.** Use loops and data to generate them.

**Pass pointers, not payloads.** Sub-agents have full tool access — they can read files themselves. Don't inline file contents into prompts. Thread prompts are capped at 10KB; anything larger is truncated.

```javascript
// BAD — stuffing file content into the prompt
content = await load("src/auth.ts")
ep = await llm(`Review this code:\n${content}`)  // wastes orchestrator context

// GOOD — pass the file path, let the sub-agent read it
ep = await llm("Review src/auth.ts for security issues")

// BAD — manually writing similar thread prompts
results = await dispatch([
    thread("Review src/auth.ts for security issues..."),
    thread("Review src/api.ts for security issues..."),
    thread("Review src/db.ts for security issues..."),
])

// GOOD — generate from data, give each thread a name
files = [...(await load("src/")).keys()].filter(f => f.endsWith(".ts"))
tasks = files.map(f => thread(`Review ${f} for security issues`, { name: f }))
results = await dispatch(tasks)
results.forEach((ep, i) => console.log(`${ep.status}: ${ep.summary.slice(0, 80)}`))
```

```javascript
// Sequential with conditional logic
modules = ["auth", "api", "database"]
for (const mod of modules) {
    ep = await llm(`Analyze the ${mod} module in src/${mod}/`)
    if (ep.status === "failure") { console.log(`${mod} failed`); continue }
    console.log(`${mod}: ${ep.findings.length} findings`)
}
```

### Options

```javascript
llm(prompt, {
    agent: "scout",       // named agent from .pi/agents/
    model: "...",         // override model
    tools: ["read"],      // restrict tool access
    timeout: 60000,       // ms
    spindle: true,        // give sub-agent its own REPL
    maxOutput: false,     // disable 50KB output cap
})

thread(task, {
    agent: "worker",
    model: "...",
    tools: ["read", "bash"],
    spindle: true,
    stepped: true,        // yield intermediate episodes
    name: "my-thread",
})
```

## Thread Communication

```javascript
results = await dispatch([
    thread("define types, then broadcast", { spindle: true }),
    thread("wait for types, then implement", { spindle: true }),
], { communicate: true })
```

Inside communicating threads:
- `spindle_send({ to: 1, msg: "done", data: {...} })` — point-to-point
- `spindle_recv({ from: 0 })` — blocking receive
- `spindle_broadcast({ msg: "update" })` — send to all
- `spindle_barrier({ name: "phase1" })` — block until all threads arrive

### Barriers

Synchronize all threads at a point before proceeding:

```javascript
results = await dispatch([
    thread("Write types. Call spindle_barrier({name:'types'}). Then implement API."),
    thread("Write fixtures. Call spindle_barrier({name:'types'}). Then run tests."),
], { communicate: true })
```

## Concurrency & Safety

### File Locking

`edit`, `write`, and `save` automatically acquire cross-process file locks. If locked, waits up to 10s then fails with `FileLockError`. In communicating dispatches, lock events are broadcast.

**Rule:** Dispatch threads should target non-overlapping files. Use barriers to sequence access to shared files.

### Output Limits

- `episode.output` capped at 50KB (head+tail preserved). Use `ep.output` when you need the actual content, not just the summary.
- `llm()` output capped at 50KB by default (`maxOutput: false` to disable). Truncation is destructive — the string itself is cut. If you see `[truncated]`, call again with higher `maxOutput`.
- Dispatch warns at 100MB aggregate output

### Recursive Spindle

Pass `{ spindle: true }` to give a sub-agent its own Spindle REPL — it can dispatch its own threads:

```javascript
results = await dispatch([
    thread("refactor auth module", { spindle: true }),
    thread("refactor API layer", { spindle: true }),
])
```

## Utilities

```javascript
await sleep(2000)
diff("old.ts", "new.ts")                       // unified diff (files or strings)
diff(oldStr, newStr, { context: 5 })            // custom context lines
await retry(() => llm("..."), { attempts: 5 })  // exponential backoff (defaults: 3 attempts, 1s delay, 2x backoff)
vars()                                          // list REPL variables
clear("bigData")                                // free memory
```

## Script Execution

```javascript
spindle_exec({ file: "workflows/audit.js" })    // runs in same REPL context with all builtins
```
