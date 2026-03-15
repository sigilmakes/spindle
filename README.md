# Spindle

Agent orchestration extension for [pi](https://pi.dev). Persistent JavaScript REPL with sub-agents as callable functions, async generator threads yielding structured episodes, and Unix socket messaging between parallel threads.

**Status:** In design. See the [plan](https://github.com/sigilmakes/spindle/blob/main/scratchpad/spindle/plans/2026-03-15-spindle-extension.md) (in the private scratchpad — ask for access).

## What it does

The LLM gets a persistent REPL via `spindle_exec`. Inside the REPL:

- **`llm(prompt, opts?)`** — one-shot sub-agent, returns a string
- **`thread(task, opts?)`** — async generator yielding structured Episodes
- **`dispatch([threads])`** — parallel execution, returns Episodes
- **`load(path)` / `save(path, content)`** — file I/O bypassing LLM context
- **Built-in tools** — `read`, `bash`, `grep`, `find`, `edit`, `write`, `ls`
- **`sleep(ms)`** — delay

Sub-agents are full pi processes with access to all tools (including MCP, extensions).

## Example

```javascript
// Research in parallel
const research = await dispatch([
  thread("Find security vulnerabilities in src/auth/", { agent: "scout" }),
  thread("Check test coverage for src/auth/", { agent: "scout" }),
])

// Plan based on findings
const [plan] = await dispatch([
  thread(`Fix plan for:\n${research.map(ep => ep.summary).join("\n")}`, { agent: "planner" })
])

// Implement fixes
const fixes = await dispatch(
  plan.findings.filter(f => /critical/i.test(f)).map(fix =>
    thread(`Fix: ${fix}`, { agent: "worker" })
  )
)
```

## Roadmap

1. **V1** — REPL + tools + llm + thread/dispatch + episodes + column UI
2. **Stepped threads** — V2 generators with intermediate episode yields
3. **`pi.callTool()`** — upstream PR for all tools in the REPL
4. **Channel messaging** — MPI-like inter-thread communication via Unix sockets
5. **Recursive Spindle** — sub-agents with their own REPLs
6. **Script execution** — run `.js` orchestration files from disk

## License

MIT
