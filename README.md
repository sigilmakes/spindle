# Spindle

Workflow orchestration for [Pi](https://github.com/earendil-works/pi-coding-agent). One tool, deterministic scripts, in-memory subagents, fleet-scale display.

## Install

```bash
pi install git:github.com/sigilmakes/spindle
```

## The shape

One agent-facing tool: `spindle`.

```js
// Inline workflow script
spindle({ script: `
export const meta = { name: "scan", description: "Scan the repo", phases: [{ title: "Map" }] };
phase("Map");
const result = await agent("Find all auth-related code", { label: "scout" });
return result;
` })

// Saved workflow
spindle({ name: "review", args: { area: "src/auth" } })

// File-backed workflow
spindle({ scriptPath: "@/workflows/audit.js", args: { dir: "src/" } })
```

Workflow scripts are plain JavaScript evaluated in a deterministic VM sandbox. The first statement must export literal metadata. Available DSL globals: `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`, `workflow()`.

## Quick start

```text
Ask Pi to run a workflow:
  "Run a workflow to inspect this repo and summarize the main modules."

Or from the operator console:
  /spindle run review
  /spindle workflows
  /spindle save review
```

Pi writes the script, calls `spindle`, and live progress renders inline with sigils and progress bars:

```text
⏣ inspect_project wf_20260530101753_86ec64
  Inspect the repository structure
  done · 3/3 · $0.0300 · 12.5s
  ████████████████ 3/3

  ⏣ Scan 1/1 · $0.0100 ██████████
    ⏣ repo inventory
  ⏣ Analyze 2/2 · $0.0200 ██████████
    ⏣ source modules
    ⏣ final summary
```

Press `Esc` to cancel a running workflow. Active subagents are aborted and surfaced as skipped.

## Workflow script shape

```js
export const meta = {
  name: 'review',
  description: 'Run a parallel code review',
  whenToUse: 'When you need multi-perspective code review',
  phases: [
    { title: 'Scan', detail: 'Map the target area' },
    { title: 'Review', detail: 'Shard specialist reviewers' },
    { title: 'Synthesize', detail: 'Combine findings' },
  ],
}

phase('Scan')
const inventory = await agent('List important files in ' + args.area, { label: 'scout' })

phase('Review')
const reviews = await parallel([
  () => agent('Security review for ' + args.area, { label: 'security', phase: 'Review' }),
  () => agent('Test-gap review for ' + args.area, { label: 'tests', phase: 'Review' }),
  () => agent('Maintainability review for ' + args.area, { label: 'style', phase: 'Review' }),
])

phase('Synthesize')
const synthesis = await agent(
  'Combine these reviews into a single report:\n' + reviews.filter(Boolean).map(r => r).join('\n---\n'),
  { label: 'synthesizer', schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string' },
      issues: { type: 'array', items: { type: 'string' } },
      suggestions: { type: 'array', items: { type: 'string' } },
    },
    required: ['verdict', 'issues'],
  } },
)

return synthesis
```

### Available globals

| Global | Description |
|--------|-------------|
| `agent(prompt, opts)` | Spawn an isolated in-memory subagent. Returns text or, with `opts.schema`, a validated object. Returns `null` on failure. |
| `parallel(thunks)` | Run an array of `() => agent(...)` thunks concurrently. Failed thunks return `null`. |
| `pipeline(items, ...stages)` | Run each item through sequential stages while items fan out concurrently. Each stage receives `(prev, original, index)`. |
| `phase(title)` | Mark the current workflow phase for grouping. |
| `log(message, data)` | Append a workflow-level log entry. |
| `args` | JSON value passed in via the tool's `args` parameter. |
| `budget` | `{ total, spent(), remaining() }` cost tracker. |
| `workflow(name, args)` | Run a nested saved workflow. Depth limited to 1 level. |
| `cwd`, `process.cwd()` | Working directory. |

### Determinism rules

Workflow scripts run inside a Node VM sandbox. The following are intentionally unavailable:

- `Date.now()`, `new Date()`, `Math.random()`
- `require`, `import`, `fs`, network APIs
- spreads, computed keys, function calls inside `meta`

This keeps `meta` parseable, runs reproducible, and the surface area small.

### Structured subagent output

Pass a JSON Schema via `opts.schema` and agent returns a validated object:

```js
const finding = await agent('Find security-sensitive files.', {
  label: 'security scan',
  schema: {
    type: 'object',
    properties: {
      paths: { type: 'array', items: { type: 'string' } },
      reason: { type: 'string' },
    },
    required: ['paths', 'reason'],
  },
})
// finding is { paths: [...], reason: '...' }
```

Under the hood this adds a `structured_output` tool with `terminate: true` to the subagent session, so it ends without an extra assistant turn.

### Failure handling

Agents that fail return `null` instead of throwing. Use `.filter(Boolean)` to skip nulls:

```js
const results = await parallel([
  () => agent('task a', { label: 'a' }),
  () => agent('task b', { label: 'b' }),  // might fail
  () => agent('task c', { label: 'c' }),
])
const successful = results.filter(Boolean) // only non-null results
```

Set `retries: N` on agent options for automatic retry before giving up.

### Caching

Agents are automatically cached by prompt + options hash. Cached results return instantly:

```js
const a = await agent('same prompt', { label: 'cached' })  // runs
const b = await agent('same prompt', { label: 'cached' })  // cached!
```

Control with `cache: "force"` (bypass cache), or `cache: "skip"` (disable caching).

## Saved workflows

Project workflows live in `.pi/threads/*.js`; global workflows in `~/.pi/agent/threads/*.js`.

Run saved workflows from the tool or console:

```text
/spindle workflows    — list saved + recent
/spindle run review   — run a saved workflow
/spindle save review  — create a new workflow from template
```

## In-memory subagents

Each `agent()` call spawns an in-memory Pi session via `createAgentSession` with `SessionManager.inMemory()`, so subagents get the full coding tool suite (read, bash, edit, write) without external process overhead. No tmux, no worktrees by default.

Set `isolation: "worktree"` on agent options for git worktree isolation.

## Fleet display

When workflows are active, Spindle renders a fleet widget below the editor with compact progress:

```text
⏣ Spindle 2 runs · 5/12 done · 3 ◎
  ⏣ review ████████░░░░ 4/8 2.2s
    Scan ████░░ 2/2
    Review ██░░░░ 2/6 ◎
  ⏣ audit ██████████ 3/4 5.1s
    Map ██████████ 2/2
    Check ██░░░░░░ 1/2 ◎
```

For fleets with many agents, phases aggregate automatically — no per-agent listing needed.

## Runtime builtins

The persistent REPL (not workflow scripts) provides:

- Tool wrappers: `read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`
- File I/O: `load`, `save`
- Agents: `subagent`, `thread`, `threads`
- MCP: `mcp`, `mcp_call`, `mcp_connect`, `mcp_disconnect`
- Utilities: `sleep`, `diff`, `retry`, `vars`, `clear`, `help`

## Commands

| Command | Description |
|---------|-------------|
| `/spindle workflows` | List saved workflows and recent runs |
| `/spindle agents` | List workflow agents across runs |
| `/spindle run <name>` | Run a saved workflow |
| `/spindle save <name>` | Create a project workflow from template |
| `/spindle attach <id>` | View agent session details |
| `/spindle message <id> <text>` | Send message to running agent |
| `/spindle stop <runId>` | Cancel a running workflow |
| `/spindle config subModel <model>` | Set default subagent model |
| `/spindle status` | Show runtime state |
| `/spindle cleanup` | Remove orphaned worktrees and branches |
| `/spindle mcp` | List MCP servers |
| `/spindle mcp reload` | Reload MCP config |
| `/spindle reset` | Reset REPL runtime state |

## MCP Integration

Full MCP client built on `@modelcontextprotocol/sdk`.

Config: `~/.pi/agent/mcp.json` or `.pi/mcp.json`.

```js
await mcp()
await mcp_call("context7", "resolve-library-id", { libraryName: "react" })
await mcp_connect("context7")
await mcp_disconnect("context7")
```

## Requirements

- **pi** ≥ 0.78.0
- **git** — for `worktree` isolation option

## License

MIT