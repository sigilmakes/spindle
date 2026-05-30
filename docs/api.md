# API Reference

## Tool: `spindle`

One tool covers Spindle's workflow engine.

```ts
spindle({ script?: string, name?: string, scriptPath?: string, args?: unknown, resumeFromRunId?: string })
```

Use:

- `{ script }` — run an inline workflow script. Must begin with `export const meta = { name, description, phases? }`.
- `{ name, args }` — run a saved workflow from `.pi/threads` or `~/.pi/agent/threads`.
- `{ scriptPath, args }` — run a workflow file. Use `@/` prefix for project-relative paths.
- `{ resumeFromRunId }` — resume from a previous run's checkpoint (same session).

## Workflow DSL

Workflow scripts must export literal metadata as the first statement:

```ts
export const meta = {
    name: "review",
    description: "Parallel review",
    whenToUse: "When you need multi-perspective review",
    phases: [{ title: "Scan" }, { title: "Review" }],
}
```

### Determinism

Scripts run inside a VM sandbox. No `Date.now()`, `Math.random()`, `new Date()`, `require`, `import`, `fs`, or network APIs. `meta` must be a pure literal — no spreads, computed keys, function calls, or template interpolation.

### Globals

| Global | Signature | Description |
|--------|-----------|-------------|
| `agent` | `(prompt: string, opts?: AgentOptions) => Promise<unknown>` | Spawn a subagent. Returns text or validated object (with `opts.schema`). Returns `null` on failure. |
| `parallel` | `(thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>` | Run thunks concurrently. Failed thunks return `null`. |
| `pipeline` | `(items: T[], ...stages: StageFn[]) => Promise<unknown[]>` | Fan-out items through sequential stages. Failed items return `null`. |
| `phase` | `(title: string) => void` | Mark current phase. |
| `log` | `(message: string, data?: unknown) => void` | Append log entry. |
| `args` | `unknown` | Tool's `args` parameter. |
| `budget` | `{ total, spent(), remaining() }` | Cost tracker. |
| `workflow` | `(name: string, args?: unknown) => Promise<unknown>` | Run nested workflow (depth ≤ 1). |
| `cwd` | `string` | Working directory. |
| `process.cwd()` | `() => string` | Returns `cwd`. |

### AgentOptions

```ts
interface AgentOptions {
    label?: string                  // Short descriptive label (2-5 words)
    phase?: string                  // Phase to assign (overrides global)
    schema?: JsonSchema             // JSON Schema for structured output
    retries?: number                // Max retry attempts (default: 0)
    cache?: "auto" | "force" | "skip"  // Caching behavior
    isolation?: "worktree"           // Git worktree isolation
    agentType?: string              // Subagent persona from .pi/agents
    model?: string                  // Model override
    systemPromptSuffix?: string     // Extra system instructions
}
```

## In-Memory Subagents

Each `agent()` call creates an in-memory Pi session with full coding tools. The `structured_output` terminate tool is injected when `opts.schema` is set.

## Rendering

Workflow results render with sigils and progress bars:

```
⏣ workflow_name wf_20260530...
  Description text
  done · 3/3 · $0.0300 · 12.5s
  ████████████████ 3/3
```

Phase breakdown and agent detail available in expanded view.

## Library

```ts
discoverWorkflows(cwd: string): WorkflowLibraryEntry[]
resolveWorkflow(cwd: string, nameOrPath: string): Promise<{ script, scriptPath? }>
saveWorkflow(cwd: string, name: string, script: string, scope?: "project" | "global"): string
parseWorkflowMeta(script: string): WorkflowMeta
```

## Fleet Display

```ts
createSnapshot(run: WorkflowRun): WorkflowSnapshot
renderFleetWidget(snapshots: WorkflowSnapshot[], theme: Theme, opts?): string[]
renderStatusLine(snapshots: WorkflowSnapshot[], theme: Theme): string
```

## Commands

| Subcommand | Description |
|------------|-------------|
| `workflows` | List saved workflows and recent runs |
| `agents` | List all workflow agents |
| `run <name>` | Run a saved workflow |
| `save <name>` | Create workflow from template |
| `attach <id>` | View agent details |
| `message <id> <text>` | Send message to agent |
| `stop <runId>` | Cancel a running workflow |
| `config subModel <model>` | Set subagent model |
| `status` | Show runtime state |
| `cleanup` | Remove orphaned worktrees/branches |
| `mcp` | List MCP servers |
| `mcp reload` | Reload MCP config |
| `reset` | Reset REPL state |