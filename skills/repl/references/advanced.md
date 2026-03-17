# Advanced Spindle

Thread communication, file locking, output limits, and recursive sub-agents.

## Thread Communication

All `dispatch()` threads can exchange messages. Each thread gets a rank (0-indexed). Communication tools are always available — no opt-in needed.

```javascript
results = await dispatch([
    thread("Define types, then broadcast to team", { spindle: true }),
    thread("Wait for types from rank 0, then implement", { spindle: true }),
])
```

Available tools inside dispatch threads:

| Tool | Purpose |
|------|---------|
| `spindle_send({ to: 1, msg: "done", data: {...} })` | Point-to-point message |
| `spindle_recv({ from: 0 })` | Blocking receive (optional `from` filter) |
| `spindle_broadcast({ msg: "update" })` | Send to all other threads |
| `spindle_barrier({ name: "phase1" })` | Block until all threads arrive |

### Barriers

Synchronize a subset of threads at a named point:

```javascript
results = await dispatch([
    thread("Write types. Call spindle_barrier({name:'types', count:2}). Then implement API."),
    thread("Write fixtures. Call spindle_barrier({name:'types', count:2}). Then run tests."),
    thread("Wait for done messages. Do NOT call the barrier."),
])
```

`count` specifies how many threads must arrive before the barrier releases. Only participating threads should call it — threads that don't participate must not call the barrier or it will deadlock. If `count` is omitted it defaults to the total thread count.

## File Locking

`edit`, `write`, and `save` automatically acquire cross-process file locks. If a file is locked, the call waits up to 10 seconds then fails with `FileLockError`. Lock acquire/release events are broadcast to all threads.

**Rule:** Dispatch threads should target non-overlapping files. Use barriers to sequence access to shared files when overlap is unavoidable.

## File Collision Detection

When multiple dispatch threads write the same file, Spindle detects the collision and adds a warning to the affected threads. This is advisory — it doesn't prevent the write, but surfaces the conflict in `episode.warnings` so you can handle it.

```javascript
results = await dispatch([...])
collisions = results.filter(ep => ep.warnings?.length)
collisions.forEach(ep => console.log(`${ep.name}: ${ep.warnings.join(", ")}`))
```

## Output Limits

| What | Limit | Behavior |
|------|-------|----------|
| REPL console output | 8192 chars | Truncated — store in variables instead |
| `episode.output` | 50KB | Head+tail preserved, middle truncated |
| `llm()` return | 50KB default | Set `maxOutput: false` to disable |
| Dispatch aggregate | 100MB warning | Logged but not enforced |

Truncation is destructive. If you see `[truncated]`, either use the structured fields (`summary`, `findings`) or re-run with `{ maxOutput: false }`.

## Recursive Spindle

Pass `{ spindle: true }` to give a sub-agent its own Spindle REPL. It can call `load()`, `dispatch()`, run scripts — the full API.

```javascript
results = await dispatch([
    thread("Refactor auth module", { spindle: true }),
    thread("Refactor API layer", { spindle: true }),
])
```

Use this for complex tasks where the sub-agent benefits from its own orchestration layer — loading files into variables, running multiple analysis passes, or spawning its own sub-agents.
