# Advanced Spindle

Read this when you need thread communication, file locking details, output limit handling, or recursive sub-agents.

## Thread Communication

Threads in a `dispatch()` can exchange messages when `{ communicate: true }` is set. Each thread gets a rank (0-indexed).

```javascript
results = await dispatch([
    thread("define types, then broadcast to team", { spindle: true }),
    thread("wait for types from rank 0, then implement", { spindle: true }),
], { communicate: true })
```

Inside communicating threads, these tools are available:

| Tool | Purpose |
|------|---------|
| `spindle_send({ to: 1, msg: "done", data: {...} })` | Point-to-point message |
| `spindle_recv({ from: 0 })` | Blocking receive (optional `from` filter) |
| `spindle_broadcast({ msg: "update" })` | Send to all other threads |
| `spindle_barrier({ name: "phase1" })` | Block until all threads arrive |

### Barriers

Synchronize all threads at a named point before any proceeds:

```javascript
results = await dispatch([
    thread("Write types. Call spindle_barrier({name:'types'}). Then implement API."),
    thread("Write fixtures. Call spindle_barrier({name:'types'}). Then run tests."),
], { communicate: true })
```

Use distinct names for multiple sync points. All threads must call the same barrier for any to unblock.

## File Locking

`edit`, `write`, and `save` automatically acquire cross-process file locks. If a file is locked, the call waits up to 10 seconds then fails with `FileLockError`. In communicating dispatches, lock acquire/release events are broadcast to all threads.

**Rule:** Dispatch threads should target non-overlapping files. Use barriers to sequence access to shared files when overlap is unavoidable.

## Output Limits

| What | Limit | Behavior |
|------|-------|----------|
| `episode.output` | 50KB | Head+tail preserved, middle truncated |
| `llm()` return | 50KB default | Set `maxOutput: false` to disable |
| Dispatch aggregate | 100MB warning | Logged but not enforced |
| REPL console output | 8192 chars | Truncated; store in variables instead |

Truncation is destructive — the string is cut. If you see `[truncated]`, either extract what you need via the sub-agent's structured fields (`summary`, `findings`) or re-run with `{ maxOutput: false }`.

## Recursive Spindle

Pass `{ spindle: true }` to give a sub-agent its own Spindle REPL. It can call `load()`, `dispatch()`, run scripts — the full API. Useful for complex tasks that benefit from their own orchestration layer.

```javascript
results = await dispatch([
    thread("refactor auth module", { spindle: true }),
    thread("refactor API layer", { spindle: true }),
])
```

## File Collision Detection

When multiple dispatch threads write to the same file, Spindle detects the collision and adds a warning to the affected episodes' `warnings` field. This is advisory — it doesn't prevent the write, but surfaces the conflict so the orchestrator can handle it.
