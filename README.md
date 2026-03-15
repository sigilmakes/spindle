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

The model gets a persistent `vm.Context` via `spindle_exec`. Variables assigned with bare assignment (`x = 42`) persist across calls.

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
// Full file content, no truncation
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
})
```

### Threads and dispatch

Threads are async generators that yield structured episodes:

```javascript
results = await dispatch([
    thread("Find vulnerabilities in src/auth/", { agent: "scout" }),
    thread("Check test coverage for src/auth/", { agent: "scout" }),
])

// Each episode has: status, summary, findings, artifacts, blockers, cost, duration
for (const ep of results) {
    console.log(ep.status, ep.summary, ep.findings)
}
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

The episode parser falls back gracefully when models don't produce clean blocks — the raw output becomes the summary.

## Commands

| Command | Purpose |
|---|---|
| `/spindle <task>` | Prime the model for wave-based orchestration |
| `/spindle reset` | Fresh REPL context |
| `/spindle config subModel <model>` | Set default sub-agent model |
| `/spindle status` | Show variables, usage, config |

## Tools

| Tool | Input | Output |
|---|---|---|
| `spindle_exec` | `{ code: string }` | Console output + episode data |
| `spindle_status` | `{}` | Variables, usage stats, config |

## Architecture

```
src/
├── index.ts      — extension entry, tool/command registration, lifecycle
├── repl.ts       — vm.Context with variable persistence, console capture, truncation
├── tools.ts      — built-in tool wrappers, load()/save() file I/O
├── agents.ts     — sub-agent spawning, agent discovery, JSON streaming, usage tracking
├── threads.ts    — async generator threads, episode parsing, dispatch concurrency
└── render.ts     — renderCall (syntax-highlighted), renderResult (column layout)
```

Sub-agents are full `pi --mode json -p --no-session` processes with access to all tools including MCP and extensions.

## Roadmap

- **Stepped threads** — V2 generators with intermediate episode yields and orchestrator control
- **`pi.callTool()`** — upstream PR to call any registered tool from the REPL
- **Channel messaging** — Unix socket communication between parallel threads
- **Recursive Spindle** — sub-agents with their own REPLs
- **Script execution** — run `.js` orchestration files from disk

## License

MIT
