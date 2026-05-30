# Architecture

## Overview

Spindle is a pi extension with one agent-facing tool, `spindle`, plus the `/spindle` operator command. The tool is intentionally simple at the doorway and richer underneath: persistent Node orchestration for quick composition, and **threads** for observable programmatic workflows.

```text
pi main session
├── spindle tool
│   ├── Persistent Node runtime
│   │   ├── tool wrappers (read, edit, bash, grep, ...)
│   │   ├── file I/O (load, save)
│   │   ├── sync subagent() -> AgentResult
│   │   ├── MCP builtins
│   │   └── inspection helpers
│   └── Thread engine
│       ├── saved threads (.pi/threads, ~/.pi/agent/threads)
│       ├── phases, logs, agent nodes, usage
│       ├── parallel(), pipeline(), nested thread()
│       ├── structured output validation
│       └── in-memory result cache
└── /spindle command (reset, config, cleanup, mcp, threads, run, save-thread)
```

## Modules

| Module | Purpose |
|--------|---------|
| `index.ts` | Extension entry. Registers the unified tool, commands, status, and builtins. |
| `repl.ts` | Persistent JavaScript runtime with declaration hoisting, last-result tracking, and Node globals. |
| `thread/` | Thread metadata, runtime, library discovery, manager, schema validation, and renderers. |
| `tools.ts` | Tool wrappers (`ToolResult`), load/save, bash. |
| `builtins.ts` | diff, retry, vars/clear, inspection helpers. |
| `agents.ts` | Agent discovery from `~/.pi/agent/agents` and `.pi/agents`. |
| `workers.ts` | `subagent()`, sync RPC child execution, worktree lifecycle. |
| `episode.ts` | Shared `<episode>` prompt contract and parser for child results. |
| `mcp.ts` | MCP client built on `@modelcontextprotocol/sdk`. |
| `mcp-config.ts` | Config loading and merging. |
| `mcp-cache.ts` | Metadata cache for tool schemas. |
| `render.ts` | TUI rendering for code/status results. |

## Runtime model

Spindle exposes a Node-flavored scope:

- `require`
- `process`
- `Buffer`
- `globalThis`
- dynamic `import()`

State persists across plain code calls. Top-level declarations are hoisted into persistent assignments; nested declarations remain block-scoped.

## Thread model

Threads are just JavaScript with a small DSL:

- `phase()` updates the visible phase timeline
- `log()` records operator-facing breadcrumbs
- `agent()` / `subagent()` run sync child agents and attach results to the active phase
- `parallel()` bounds concurrency
- `pipeline()` makes sharded multi-stage work easy
- `thread()` composes saved threads
- `answer.done()` marks the final result

Saved thread metadata enables discovery and operator UI:

```js
export const meta = {
    name: "review",
    description: "Parallel code review",
    phases: [{ title: "Scan" }, { title: "Review" }],
}
```

## Subagent lifecycle

1. `agent()` or `subagent()` is called
2. Optional worktree is created
3. A child pi process starts in RPC mode
4. The task is sent via RPC
5. Spindle reads the final assistant message and parses the `<episode>` block
6. The thread node records status, timing, usage, and result

## Rendering and UI

Spindle follows the current Pi extension/TUI API:

- `renderCall` and `renderResult` return `Text` components
- compact default rendering, expanded phase/agent detail on demand
- `ctx.ui.setStatus()` shows active/recent thread state in the footer
- slash commands use `ctx.ui.notify()`, `ctx.ui.editor()`, and completions for saved threads

## Cache and resume foundations

The thread manager owns an in-memory cache shared across runs. Agent calls key on prompt/options and can opt out with `cache: "skip"` or refresh with `cache: "force"`. Run details are stored in tool `details`, so Pi sessions have the full rendered state in history. Persistent disk resume is intentionally left as a later layer; the public model does not need to change.
