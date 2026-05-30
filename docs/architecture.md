# Architecture

## Overview

Spindle is a pi extension with two tools (`spindle_exec`, `spindle_status`) and a slash command. The center of the system is a **persistent JavaScript runtime with a proper Node environment**.

```text
pi (main session)
├── spindle_exec tool
│   └── Repl (persistent runtime)
│       ├── real Node globals (require, process, Buffer, globalThis)
│       ├── tool wrappers (read, edit, bash, grep, ...)
│       ├── file I/O (load, save)
│       ├── sync subagent() -> AgentResult
│       ├── MCP builtins
│       └── utilities (diff, retry, vars, clear, inspect helpers)
├── spindle_status tool
└── /spindle command (reset, config, cleanup, mcp)
```

## Modules

| Module | Purpose |
|--------|---------|
| `index.ts` | Extension entry. Registers tools, commands, wires builtins. |
| `repl.ts` | Persistent JavaScript runtime with declaration hoisting, last-result tracking, and proper Node globals. |
| `tools.ts` | Tool wrappers (ToolResult), load/save, bash. |
| `builtins.ts` | diff, retry, vars/clear, inspection helpers. |
| `agents.ts` | Agent discovery from ~/.pi/agent/agents and .pi/agents. |
| `workers.ts` | `subagent()`, `AgentResult`, sync RPC child execution, worktree lifecycle. |
| `episode.ts` | Shared `<episode>` prompt contract and parser for child results. |
| `mcp.ts` | MCP client built on `@modelcontextprotocol/sdk`. Full protocol support. |
| `mcp-config.ts` | Config loading and merging (project > global > editor imports). |
| `mcp-cache.ts` | Metadata cache for tool schemas (discovery without live connections). |
| `render.ts` | TUI rendering for `spindle_exec` and `spindle_status`. |

## Runtime model

Spindle is no longer centered on a `vm` sandbox. The runtime exposes a Node-flavored scope:

- `require`
- `process`
- `Buffer`
- `globalThis`
- dynamic `import()`

State persists across `spindle_exec` calls. Top-level `const` / `let` / `var` declarations are hoisted into persistent assignments, while nested declarations remain block-scoped.

## Subagent lifecycle

1. `await subagent("task", opts)` is called in the runtime
2. If `worktree: true`, create a git worktree and branch under `.worktrees/`
3. Start a child pi process in **RPC mode**:
   - `pi --mode rpc --no-session ...`
4. Optionally append a system prompt that includes the `<episode>` result contract
5. Send the task via RPC `prompt`
6. Stream RPC events until `agent_end`
7. Extract the last assistant message, parse the `<episode>` block, and build `AgentResult`
8. Return `AgentResult` directly to the caller

The main process does **not** rely on a poller or `.spindle/status.json` as the primary truth path anymore.

## Last-result tracking

After each `spindle_exec` call, the runtime updates:

- `_last`
- `_lastValue`
- `_lastResult`
- `_lastOutput`
- `_lastFullOutput`
- `_lastError`
- `_lastDurationMs`
- `_lastStatus`
- `_lastTruncated`

This makes truncation survivable: large values remain in runtime state even when printed output is clipped.

## Inspection helpers

`builtins.ts` exposes lightweight inspection helpers to reduce repeated ad-hoc debugging code:

- `inspectVar(name)`
- `keys(valueOrName)`
- `shape(valueOrName)`
- `sample(valueOrName, n?)`
- `preview(valueOrName, opts?)`

These work on either raw values or variable names already stored in runtime state.

## Error semantics

`repl.ts` normalizes execution outcomes into explicit statuses:

- `ok`
- `aborted_by_user`
- `runtime_error`
- `process_terminated`

These statuses are stored in `_lastStatus` and surfaced in `spindle_exec` details.

## tmux

tmux is no longer the primary coordination backbone. It may still be useful for auxiliary observability or cleanup, but sync child execution now uses RPC as the source of truth.
