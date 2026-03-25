# Spindle API Reference

## Tools

### `spindle_exec`

Execute JavaScript in a persistent REPL. Variables assigned with bare assignment persist across calls. Output truncated to 8192 chars.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `code` | `string` | one of `code`/`file` | JavaScript code to execute |
| `file` | `string` | one of `code`/`file` | Path to a `.js` or `.mjs` file to run in the REPL context |

Provide exactly one of `code` or `file`. The file form runs the script with access to all builtins and persisted variables.

### `spindle_status`

Show REPL variables, cumulative usage stats, and configuration. Takes no parameters.

Returns:
- **variables** — name, type, and preview of each user-defined variable
- **usage** — total LLM calls, episodes, and cost across all sub-agent invocations
- **config** — current sub-model and output limit

### `spindle_send`

*Registered dynamically inside sub-agents spawned with `{ communicate: true }`.* Send a message to another thread by rank.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | `number` | yes | Destination thread rank (0-indexed) |
| `msg` | `string` | yes | Message string |
| `data` | `any` | no | Structured data payload |

### `spindle_recv`

*Registered dynamically inside sub-agents spawned with `{ communicate: true }`.* Block until a message arrives.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | `number` | no | Only accept messages from this rank. Omit to accept from any. |

Returns the message as: `From rank <n>: <msg>` with optional `Data: <JSON>`.

### `spindle_broadcast`

*Registered dynamically inside sub-agents spawned with `{ communicate: true }`.* Send a message to all other threads.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `msg` | `string` | yes | Message string |
| `data` | `any` | no | Structured data payload |

---

## Commands

| Command | Description |
|---------|-------------|
| `/spindle <task>` | Prime the model for wave-based orchestration on `<task>` |
| `/spindle reset` | Fresh REPL context. Preserves built-in functions, clears user variables. |
| `/spindle config subModel <model>` | Set the default model for sub-agents. Persisted in session. |
| `/spindle config maxDepth <N>` | Set max spawn depth (default: 3). Persisted in session. |
| `/spindle status` | Show variables, cumulative usage, and config |
| `/spindle run <path.js>` | Execute a `.js`/`.mjs` script file in the REPL |

---

## REPL Built-in Tools

Pi's standard tools, callable as async functions. Each returns the tool's text output as a string. Subject to pi's truncation limits (50KB or 2000 lines, whichever is hit first).

### `read(params)`

```javascript
text = await read({ path: "src/auth/login.ts" })
text = await read({ path: "src/auth/login.ts", offset: 100, limit: 50 })
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | File path (relative to cwd) |
| `offset` | `number` | no | Line number to start reading from (1-indexed) |
| `limit` | `number` | no | Maximum number of lines to read |

### `bash(params)`

```javascript
output = await bash({ command: "npm test 2>&1" })
output = await bash({ command: "find . -name '*.ts' | wc -l", timeout: 30 })
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | `string` | yes | Bash command to execute |
| `timeout` | `number` | no | Timeout in seconds |

### `grep(params)`

```javascript
matches = await grep({ pattern: "TODO", path: "src/" })
matches = await grep({ pattern: "import.*auth", path: "src/", glob: "*.ts", ignoreCase: true })
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | yes | Search pattern (regex or literal) |
| `path` | `string` | no | Directory or file to search (default: cwd) |
| `glob` | `string` | no | Filter files by glob pattern |
| `ignoreCase` | `boolean` | no | Case-insensitive search |
| `literal` | `boolean` | no | Treat pattern as literal string |
| `context` | `number` | no | Lines of context before and after each match |
| `limit` | `number` | no | Maximum number of matches (default: 100) |

### `find(params)`

```javascript
files = await find({ pattern: "*.ts", path: "src/" })
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | `string` | yes | Glob pattern to match |
| `path` | `string` | no | Directory to search (default: cwd) |
| `limit` | `number` | no | Maximum number of results (default: 1000) |

### `edit(params)`

```javascript
await edit({ path: "src/foo.ts", oldText: "const x = 1", newText: "const x = 2" })
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | File path |
| `oldText` | `string` | yes | Exact text to find (must match including whitespace) |
| `newText` | `string` | yes | Replacement text |

### `write(params)`

```javascript
await write({ path: "docs/report.md", content: report })
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | yes | File path. Creates parent directories automatically. |
| `content` | `string` | yes | Content to write |

### `ls(params)`

```javascript
listing = await ls({ path: "src/" })
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | `string` | no | Directory to list (default: cwd) |
| `limit` | `number` | no | Maximum entries (default: 500) |

---

## MCP (Model Context Protocol)

Call external services through MCP servers. Powered by [mcporter](https://github.com/steipete/mcporter). Config: `~/.pi/agent/mcp.json`.

mcporter is lazy-loaded — no startup cost until you make your first MCP call.

### `mcp(server?, options?)`

Discover servers and tools.

```javascript
await mcp()                             // list all configured servers
await mcp("linear")                     // list tools for a server
await mcp("linear", { schema: true })   // include parameter schemas
```

Returns `ToolResult`. The `output` field contains the formatted listing.

### `mcp_call(server, toolName, args?)`

One-shot tool call. Uses a pooled connection (reused across calls to the same server).

```javascript
result = await mcp_call("context7", "resolve-library-id", { libraryName: "react" })
console.log(result.output)   // text content from the MCP response
console.log(result.ok)       // false if the MCP server returned isError
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | `string` | yes | MCP server name (from config) |
| `toolName` | `string` | yes | Tool name on that server |
| `args` | `Record<string, unknown>` | no | Arguments to pass to the tool |

Returns `ToolResult`. Errors from the MCP server or transport are returned as `ToolResult.fail()` (not thrown).

### `mcp_connect(server)`

Create a persistent proxy for repeated calls to the same server. The proxy caches schemas, validates arguments, and maps camelCase method names to the server's tool names.

```javascript
linear = await mcp_connect("linear")

// Methods are camelCase — createIssue maps to create_issue
issue = await linear.createIssue({ title: "Bug", team: "ENG" })

// Results have .text(), .json(), .markdown(), .images()
docs = await linear.searchDocumentation({ query: "API" })
console.log(docs.text())
console.log(docs.json())
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server` | `string` | yes | MCP server name (from config) |

Returns a `ServerProxy` (from mcporter). **Throws** on unknown server — use `mcp()` to discover available servers first.

The proxy lives in the REPL variable scope and survives across `spindle_exec` calls.

### `mcp_disconnect(server?)`

Close MCP connections.

```javascript
await mcp_disconnect("linear")   // close one server
await mcp_disconnect()            // close all, reset runtime
```

Returns `ToolResult`. Closing all connections also resets the internal runtime, so the next MCP call creates a fresh one.

### Config format

`~/.pi/agent/mcp.json` follows the standard MCP config format:

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp"
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "headers": {
        "Authorization": "Bearer ${LINEAR_API_KEY}"
      }
    }
  }
}
```

Supports `command`/`args`/`env` for stdio transports and `url`/`headers` for HTTP. Environment variable interpolation via `${VAR}` syntax.

---

## Spawn Depth Limits

Sub-agents with `{ spindle: true }` can dispatch further sub-agents. To prevent runaway recursion, spawning is capped at a configurable depth.

### Configuration

| Method | Scope | Description |
|--------|-------|-------------|
| Default | global | Max depth is 3 |
| `SPINDLE_MAX_DEPTH` env var | process | Override for this process and all children |
| `/spindle config maxDepth <N>` | session | Persisted in session, takes effect immediately |
| `thread(task, { maxDepth: N })` | sub-tree | Override for a specific sub-agent and its children |

### Behaviour at the limit

When `currentDepth >= maxDepth`:
- `llm()`, `thread()`, `dispatch()` throw: `"Spawn depth limit reached (N/N). Cannot dispatch sub-agents at this depth."`
- All other builtins work normally (`read`, `write`, `bash`, `mcp`, etc.)
- The agent can still do useful work — just can't spawn more agents

### Environment variables

| Variable | Description |
|----------|-------------|
| `SPINDLE_DEPTH` | Current depth (0 = top-level, set automatically by parent) |
| `SPINDLE_MAX_DEPTH` | Maximum allowed depth (default: 3) |

Depth env vars are always set on sub-agent processes and take precedence over `options.env` (cannot be overridden by user code).

### Per-subtree override

```javascript
// Grant a specific sub-agent a deeper limit
thread("complex multi-level task", { spindle: true, maxDepth: 5 })
```

---

## File I/O

Bypass pi's truncation limits. No output enters the REPL's 8192-char console buffer — data goes straight into a variable.

### `load(path)`

Load a file or directory into a variable. Max 10MB.

```javascript
// File → string
data = await load("src/auth/login.ts")

// Directory → Map<relativePath, content>
project = await load("src/auth/")
```

- **File**: returns the full file content as a `string`.
- **Directory**: recursively reads all files, returns a `Map<string, string>` keyed by relative path. Skips `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `__pycache__`, `.venv`, `venv`, `.tox`, and dotfiles.
- Throws if file exceeds 10MB. Use `read()` with `offset`/`limit` for larger files.

### `save(path, content)`

Write a string to a file. Creates parent directories automatically.

```javascript
await save("docs/audit.md", report)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | File path (relative to cwd) |
| `content` | `string` | Content to write |

---

## Sub-agents

### `llm(prompt, options?)`

Spawn a one-shot sub-agent. Returns the agent's final text output as a `string`.

```javascript
answer = await llm("What is the capital of France?")

summary = await llm("Summarize this code: " + code, {
    agent: "scout",
    model: "claude-sonnet-4-20250514",
    tools: ["read", "grep"],
    timeout: 60000,
    spindle: true,
})
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agent` | `string` | none | Named agent from `~/.pi/agent/agents/` or `.pi/agents/` |
| `model` | `string` | sub-model config or host default | Override the model |
| `tools` | `string[]` | all tools | Restrict available tools |
| `timeout` | `number` | none | Wall-clock timeout in milliseconds |
| `spindle` | `boolean` | `false` | Give the sub-agent its own Spindle REPL ([Recursive Spindle](#recursive-spindle)) |
| `maxDepth` | `number` | 3 | Override max spawn depth for this sub-tree ([Spawn Depth Limits](#spawn-depth-limits)) |

Sub-agents run as `pi --mode json -p --no-session` processes with access to all tools including MCP and extensions. Throws on error.

### Agent discovery

Agents are Markdown files with YAML frontmatter. Spindle searches two locations:

1. **User agents**: `~/.pi/agent/agents/*.md`
2. **Project agents**: `.pi/agents/*.md` (walks up from cwd)

Required frontmatter fields: `name`, `description`. Optional: `tools` (comma-separated), `model`. The Markdown body becomes the system prompt.

---

## Threads and Dispatch

### `thread(task, options?)`

Create a thread specification. Returns a `ThreadSpec` — an async generator that yields `Episode` objects. Threads are lazy; the sub-agent process starts when the thread is first iterated or passed to `dispatch()`.

```javascript
t = thread("Analyze the auth module", { agent: "scout" })
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agent` | `string` | none | Named agent |
| `model` | `string` | sub-model config | Override model |
| `tools` | `string[]` | all | Restrict tools |
| `timeout` | `number` | none | Wall-clock timeout in ms |
| `spindle` | `boolean` | `false` | Give the sub-agent its own Spindle REPL |
| `stepped` | `boolean` | `false` | Emit intermediate episodes at checkpoints ([Stepped Threads](#stepped-threads)) |
| `maxDepth` | `number` | 3 | Override max spawn depth for this sub-tree ([Spawn Depth Limits](#spawn-depth-limits)) |

### `dispatch(threads, options?)`

Run threads in parallel. Returns `Episode[]` in the same order as the input array.

```javascript
results = await dispatch([
    thread("Find vulnerabilities in src/auth/", { agent: "scout" }),
    thread("Check test coverage", { agent: "scout" }),
    thread("Review error handling", { agent: "scout" }),
])
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `communicate` | `boolean` | `false` | Enable inter-thread messaging ([Thread Communication](#thread-communication)) |

All threads run concurrently. Dispatch resolves when every thread completes.

### Direct thread consumption

Threads implement `AsyncGenerator<Episode>` and can be consumed directly with `for await...of`:

```javascript
gen = thread("Long analysis", { agent: "scout", stepped: true })
for await (const episode of gen) {
    console.log(`[${episode.status}] ${episode.summary}`)
    if (episode.status === "blocked") break
}
```

Calling `.return()` on the generator aborts the sub-agent process.

---

## Episodes

Every thread produces a structured `Episode` as its final yield. Stepped threads also yield intermediate episodes with `status: "running"`.

### Episode fields

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"success" \| "failure" \| "blocked" \| "running"` | Outcome. `running` only appears in intermediate stepped episodes. |
| `summary` | `string` | One paragraph describing what was accomplished |
| `findings` | `string[]` | Key findings or deliverables |
| `artifacts` | `string[]` | Paths to files created or modified |
| `blockers` | `string[]` | What's preventing progress (when `status` is `blocked`) |
| `toolCalls` | `number` | Number of tool calls made by the sub-agent |
| `raw` | `string` | Full text output from the sub-agent |
| `task` | `string` | The original task prompt |
| `agent` | `string` | Agent name (or `"anonymous"`) |
| `model` | `string` | Model used by the sub-agent |
| `cost` | `number` | Total cost in dollars |
| `duration` | `number` | Wall-clock time in milliseconds |

### Episode block format

Sub-agents emit episodes as XML blocks in their output. The parser extracts the **last** `<episode>` block:

```
<episode>
status: success | failure | blocked
summary: One paragraph describing what you accomplished and key conclusions.
findings:
- Finding or deliverable 1
- Finding or deliverable 2
artifacts:
- path/to/file — what was created or modified
blockers:
- (only if status is blocked) What's preventing progress
</episode>
```

When no `<episode>` block is found, the raw output (first 500 chars) becomes the summary, and status is inferred from the process exit code.

---

## Thread Communication

Enable inter-thread messaging by passing `{ communicate: true }` to `dispatch()`. Each thread gets:

- A **rank** — its 0-based index in the dispatch array
- A **size** — the total number of threads
- Three tools: `spindle_send`, `spindle_recv`, `spindle_broadcast`

Communication uses a Unix domain socket server with length-prefixed framing. Messages are queued for threads that haven't connected yet (up to 1000 per rank).

```javascript
results = await dispatch([
    thread("You are the coordinator (rank 0 of 4). Collect results from ranks 1-3 using spindle_recv.", {
        agent: "planner",
    }),
    thread("Analyze src/auth/. Send findings to rank 0 using spindle_send.", { agent: "scout" }),
    thread("Analyze src/db/. Send findings to rank 0 using spindle_send.", { agent: "scout" }),
    thread("Analyze src/routes/. Send findings to rank 0 using spindle_send.", { agent: "scout" }),
], { communicate: true })
```

### Message format

Messages carry a `msg` string and an optional `data` payload (any JSON-serializable value).

### Environment variables

Communicating sub-agents receive these environment variables:

| Variable | Description |
|----------|-------------|
| `SPINDLE_RANK` | This thread's rank (0-indexed) |
| `SPINDLE_SIZE` | Total number of threads |
| `SPINDLE_COMM` | Unix socket path for the comm server |
| `SPINDLE_DEPTH` | Current spawn depth (0 = top-level) |
| `SPINDLE_MAX_DEPTH` | Maximum allowed spawn depth (default: 3) |

---

## Stepped Threads

Pass `{ stepped: true }` to `thread()` to receive intermediate progress episodes. The sub-agent is instructed to emit `<episode>` blocks with `status: running` at natural checkpoints.

```javascript
results = await dispatch([
    thread("Refactor the auth module in three phases", {
        agent: "worker",
        stepped: true,
    }),
])
```

Intermediate episodes (`status: running`) are:
- Yielded by the async generator when consuming threads directly
- Tracked on the `ThreadState` during dispatch (visible in the live display)

The **final** episode (with a terminal status) is always parsed from the complete sub-agent result and carries accurate cost, duration, and tool call counts.

### Stepped episode prompt

Stepped agents receive instructions to emit checkpoints:

```
<episode>
status: running
summary: One paragraph describing what you just accomplished in this step.
findings:
- Key finding or deliverable from this step
artifacts:
- path/to/file — what was created or modified in this step
blockers:
</episode>
```

---

## Recursive Spindle

Pass `{ spindle: true }` to `thread()` or `llm()` to give a sub-agent its own Spindle REPL. The sub-agent can use `spindle_exec`, call `dispatch()` with its own threads, and spawn further sub-agents — full recursive orchestration.

```javascript
results = await dispatch([
    thread("Audit and fix all modules in src/", {
        agent: "worker",
        spindle: true,
    }),
])
```

Implementation: the parent's extension directory is passed via `--extension` to the spawned `pi` process, so the sub-agent loads its own instance of Spindle.

---

## Script Execution

Run `.js` or `.mjs` files in the REPL context. The script shares the same `vm.Context` — all builtins and persisted variables are available.

### Via tool

```javascript
spindle_exec({ file: "scripts/audit.js" })
```

### Via command

```
/spindle run scripts/audit.js
```

File must end in `.js` or `.mjs`. The script's `console.log` output and any errors are returned like normal `spindle_exec` results.

---

## Utilities

### `sleep(ms)`

Pause execution for `ms` milliseconds. Returns a `Promise<void>`.

```javascript
await sleep(2000)
```

---

## Variable Persistence

The REPL runs in a `vm.Context` using sloppy-mode async IIFEs. Assignments without `const`, `let`, or `var` persist on the context object across calls:

```javascript
// Cell 1
x = 42
data = await load("src/")

// Cell 2 — x and data are still available
console.log(x)              // 42
console.log(data.size)      // number of files loaded
```

Variables declared with `const` or `let` are block-scoped to that execution and do **not** persist.

### Reset

`/spindle reset` clears all user variables and creates a fresh context. Built-in functions (`read`, `bash`, `grep`, `find`, `edit`, `write`, `ls`, `load`, `save`, `llm`, `thread`, `dispatch`, `sleep`) are preserved.

---

## Output Truncation

REPL console output is truncated to **8192 characters**. When truncated, the output ends with:

```
... [truncated, <N> total chars]
```

Store large results in variables and `console.log` only what you need.

---

## Architecture

```
src/
├── index.ts        — extension entry, tool/command registration, lifecycle, depth limits
├── repl.ts         — vm.Context with variable persistence, console capture, truncation
├── tools.ts        — built-in tool wrappers, load()/save() file I/O
├── agents.ts       — sub-agent spawning, agent discovery, JSON streaming, depth propagation
├── threads.ts      — async generator threads, episode parsing, parallel dispatch
├── mcp.ts          — MCP integration via mcporter (lazy-loaded runtime, connection pooling)
├── render.ts       — renderCall (syntax-highlighted), renderResult (column layout)
└── comm/
    ├── index.ts    — barrel export
    ├── types.ts    — CommMessage type (announce, send, broadcast)
    ├── framing.ts  — length-prefixed frame encoding/decoding
    ├── server.ts   — Unix socket server, routing, per-rank message queuing
    └── client.ts   — Unix socket client, inbox, blocking recv with waiters
```
