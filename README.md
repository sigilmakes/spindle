# Spindle

Agent orchestration extension for [pi](https://github.com/mariozechner/pi). Gives the LLM a persistent JavaScript REPL where sub-agents are callable functions, async generator threads yield structured episodes, and parallel work is dispatched with concurrency control.

Based on ideas from [Recursive Language Models](https://arxiv.org/abs/2512.24601) (persistent REPL with variables instead of context stuffing) and [Slate](https://randomlabs.ai/blog/slate) (thread weaving with episode-based checkpoints).

## Install

```bash
# Copy or symlink into your extensions directory
cp -r /path/to/spindle ~/.pi/agent/extensions/spindle

# Or load directly
pi --extension /path/to/spindle/dist/index.js
```

## What's in the REPL

The model gets a persistent `vm.Context` via `spindle_exec`. Variables assigned with bare assignment (`x = 42`) persist across calls. Output is truncated to 8192 chars — store results in variables, `console.log` what you need.

### Built-in tools

```javascript
await read({ path: "src/auth/login.ts" })
await bash({ command: "npm test" })
await grep({ pattern: "TODO", path: "src/" })
await find({ pattern: "*.ts", path: "src/" })
await edit({ path: "src/foo.ts", oldText: "old", newText: "new" })
await write({ path: "docs/report.md", content: report })
await ls({ path: "src/" })
```

These have pi's truncation limits (50KB/2000 lines). Use `load()` for full content.

### File I/O

```javascript
// Full file content, no truncation (up to 10MB)
data = await load("src/auth/login.ts")

// Entire directory as Map<relativePath, content>
project = await load("src/auth/")

// Write without entering context
await save("docs/audit.md", report)
```

### One-shot sub-agents

```javascript
answer = await llm("What is the capital of France?")

summary = await llm("Summarize this code: " + code, {
    agent: "scout",    // named agent from ~/.pi/agent/agents/
    model: "...",      // override model
    tools: ["read"],   // restrict tools
    timeout: 60000,    // wall-clock ms
    spindle: true,     // give the sub-agent its own Spindle REPL
})
```

Sub-agents are full `pi --mode json -p --no-session` processes with access to all tools including MCP and extensions.

### Threads and dispatch

Threads are async generators that yield structured episodes:

```javascript
results = await dispatch([
    thread("Find vulnerabilities in src/auth/", { agent: "scout" }),
    thread("Check test coverage for src/auth/", { agent: "scout" }),
], { concurrency: 4 })

// Each episode has: status, summary, findings, artifacts, blockers, cost, duration
for (const ep of results) {
    console.log(ep.status, ep.summary, ep.findings)
}
```

Default concurrency is 4, max is 8.

### Thread communication

Pass `{ communicate: true }` to `dispatch` to give threads a Unix socket message bus. Each thread gets a rank (its index in the array) and three tools:

- **`spindle_send`** — send a message to a thread by rank
- **`spindle_recv`** — block until a message arrives (optionally filter by source rank)
- **`spindle_broadcast`** — send a message to all other threads

Messages carry a string `msg` and optional structured `data` payload. The server queues messages for threads that haven't connected yet.

```javascript
results = await dispatch([
    thread("You are the coordinator (rank 0 of 3). Collect results from ranks 1 and 2, then synthesize a report.", { agent: "planner" }),
    thread("Analyze src/auth/ for injection vulnerabilities. Send findings to rank 0.", { agent: "scout" }),
    thread("Analyze src/auth/ for auth bypass vulnerabilities. Send findings to rank 0.", { agent: "scout" }),
], { communicate: true })
```

### Stepped threads

Pass `{ stepped: true }` to `thread()` to get intermediate progress episodes. The sub-agent is instructed to emit `<episode>` blocks with `status: running` at natural checkpoints during execution. These intermediate episodes appear on the thread state and are yielded by the async generator.

```javascript
results = await dispatch([
    thread("Refactor the auth module in three phases", {
        agent: "worker",
        stepped: true,
    }),
])
```

Threads can also be consumed directly as async generators:

```javascript
gen = thread("Long running analysis", { agent: "scout", stepped: true })
for await (const episode of gen) {
    console.log(`[${episode.status}] ${episode.summary}`)
}
```

### Recursive Spindle

Pass `{ spindle: true }` to `thread()` or `llm()` to give the sub-agent its own Spindle REPL. The sub-agent can use `spindle_exec`, dispatch its own threads, and spawn further sub-agents — full recursive orchestration.

```javascript
results = await dispatch([
    thread("Audit and fix all modules in src/", {
        agent: "worker",
        spindle: true,  // this agent gets its own REPL and can dispatch sub-threads
    }),
])
```

### Script execution

Run `.js` or `.mjs` files in the REPL context. The script has access to all builtins and persisted variables:

```javascript
spindle_exec({ file: "scripts/audit.js" })
```

Or from the command line:

```
/spindle run scripts/audit.js
```

### Utilities

```javascript
await sleep(2000)
```

## Example: security audit

```javascript
// Cell 1: scan + research
files = (await find({ path: "src/auth/", pattern: "*.ts" })).trim().split("\n")
smells = await grep({ pattern: "(eval\\(|hardcoded|md5)", path: "src/auth/" })
console.log(files.length + " files, " + (smells ? smells.split("\\n").length : 0) + " smells")

research = await dispatch([
    thread("Analyze src/auth/ for auth bypass, token handling, session weaknesses", { agent: "scout" }),
    thread("Check src/auth/ for injection, XSS, CSRF", { agent: "scout" }),
])
```

```javascript
// Cell 2: plan
findings = research.map(ep =>
    ep.summary + "\n" + ep.findings.map(f => "- " + f).join("\n")
).join("\n\n")

plan = (await dispatch([
    thread("Security audit findings:\n" + findings + "\n\nCreate prioritised fix plan.", { agent: "planner" })
]))[0]
```

```javascript
// Cell 3: fix + test
critical = plan.findings.filter(f => /critical|high/i.test(f))
fixes = await dispatch(
    critical.map(fix => thread("Fix: " + fix, { agent: "worker" }))
)
testResult = await bash({ command: "npm test 2>&1" })
console.log(testResult.includes("FAIL") ? "FAILING" : "PASSING")
```

```javascript
// Cell 4: report
report = "# Security Audit\n\n" +
    research.flatMap(ep => ep.findings).map(f => "- " + f).join("\n") + "\n\n" +
    fixes.map(ep => "- [" + ep.status + "] " + ep.summary).join("\n")
await save("docs/security-audit.md", report)
```

## Example: coordinated research with thread communication

```javascript
// Three scouts research different areas, a coordinator synthesizes
results = await dispatch([
    thread(`You are the coordinator (rank 0 of 4). Wait for findings from ranks 1-3 using spindle_recv, then write a unified report to docs/research.md.`, { agent: "planner" }),
    thread(`Research the authentication system in src/auth/. When done, use spindle_send to send your findings to rank 0.`, { agent: "scout" }),
    thread(`Research the database layer in src/db/. When done, use spindle_send to send your findings to rank 0.`, { agent: "scout" }),
    thread(`Research the API routes in src/routes/. When done, use spindle_send to send your findings to rank 0.`, { agent: "scout" }),
], { communicate: true })
```

## Episodes

Thread sub-agents produce structured episodes:

```
status: success | failure | blocked
summary: One paragraph of what was accomplished
findings:
- Key finding 1
- Key finding 2
artifacts:
- path/to/modified/file
blockers:
- (if blocked) What's preventing progress
```

The episode parser grabs the last `<episode>` block from the agent's output. When models don't produce clean blocks, the raw output becomes the summary.

Stepped threads also emit intermediate episodes with `status: running` at checkpoints during execution.

## Commands

| Command | Purpose |
|---|---|
| `/spindle <task>` | Prime the model for wave-based orchestration |
| `/spindle reset` | Fresh REPL context (preserves built-in functions) |
| `/spindle config subModel <model>` | Set default sub-agent model |
| `/spindle status` | Show variables, usage, config |
| `/spindle run <path.js>` | Execute a script file in the REPL |

## Tools

| Tool | Input | Output |
|---|---|---|
| `spindle_exec` | `{ code: string }` or `{ file: string }` | Console output + episode data |
| `spindle_status` | `{}` | Variables, usage stats, config |
| `spindle_send` | `{ to: number, msg: string, data?: any }` | *(comm threads only)* Send to rank |
| `spindle_recv` | `{ from?: number }` | *(comm threads only)* Block until message arrives |
| `spindle_broadcast` | `{ msg: string, data?: any }` | *(comm threads only)* Send to all other threads |

`spindle_send`, `spindle_recv`, and `spindle_broadcast` are registered dynamically inside sub-agents spawned with `{ communicate: true }`.

## Architecture

```
src/
├── index.ts        — extension entry, tool/command registration, lifecycle
├── repl.ts         — vm.Context with variable persistence, console capture, truncation
├── tools.ts        — built-in tool wrappers, load()/save() file I/O
├── agents.ts       — sub-agent spawning, agent discovery, JSON streaming, usage tracking
├── threads.ts      — async generator threads, episode parsing, dispatch concurrency
├── render.ts       — renderCall (syntax-highlighted), renderResult (column layout)
└── comm/
    ├── index.ts    — barrel export
    ├── types.ts    — CommMessage type (announce, send, broadcast)
    ├── framing.ts  — length-prefixed frame encoding/decoding
    ├── server.ts   — Unix socket server, routing, per-rank message queuing
    └── client.ts   — Unix socket client, inbox, blocking recv with waiters
```

## License

MIT
