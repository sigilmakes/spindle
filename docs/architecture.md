# Architecture

## Overview

Spindle is a pi extension with two tools (`spindle_exec`, `spindle_status`) and a slash command. Everything goes through the REPL.

```
pi (main session)
├── spindle_exec tool
│   └── Repl (persistent vm context)
│       ├── Tool wrappers (read, edit, bash, grep, ...)
│       ├── File I/O (load, save)
│       ├── subagent() → SubagentHandle
│       ├── MCP builtins
│       └── Utilities (diff, retry, sleep, ...)
├── spindle_status tool
├── /spindle command (attach, list, reset, config)
├── Poller (polls status files)
└── Dashboard (setWidget)
```

## Modules

| Module | Purpose |
|--------|---------|
| `index.ts` | Extension entry. Registers tools, commands, wires builtins. |
| `repl.ts` | Persistent JavaScript VM context with declaration hoisting. |
| `tools.ts` | Tool wrappers (ToolResult), load/save, bash. |
| `builtins.ts` | diff, retry, vars/clear. |
| `agents.ts` | Agent discovery from ~/.pi/agent/agents and .pi/agents. |
| `workers.ts` | subagent(), SubagentHandle, AgentResult, worktree + tmux lifecycle. |
| `worker-extension.ts` | Pi extension loaded by subagents. Writes status files, parses episodes. |
| `poller.ts` | Polls .spindle/status.json, fires callbacks. |
| `dashboard.ts` | Renders subagent status widget. |
| `mcp.ts` | MCP integration via mcporter. |
| `render.ts` | TUI rendering for spindle_exec and spindle_status. |

## Subagent Lifecycle

1. `subagent("task")` called in REPL
2. If `worktree: true`: `git worktree add .worktrees/w0 -b spindle/w0`
3. `tmux new-session -d -s spindle-w0`
4. `pi -p --no-session -e worker-extension.ts "Task: ..."`
5. Worker extension:
   - `before_agent_start` → injects `<episode>` prompt into system prompt
   - `tool_execution_start/end` → writes `.spindle/status.json` with current tool
   - `turn_end` → updates turns, cost
   - `agent_end` → parses `<episode>` block, writes final status with episode data, calls `ctx.shutdown()`
6. Poller reads status files every 2s → updates dashboard, fires completion notification
7. Notification: `pi.sendMessage({ details: AgentResult })` with `deliverAs: "followUp", triggerTurn: true`
8. Orchestrator: `r = await h.result` → `AgentResult` with structured episode data

## Design Decisions

### One function: subagent()
One function, one result type. `worktree` option controls isolation.

### Subagents are isolated
Each gets its own tmux session. With `worktree: true`, also its own filesystem. No shared state, no messaging.

### Structured episodes
The worker extension injects the episode prompt and parses the `<episode>` block. The orchestrator gets `findings[]`, `artifacts[]`, `blockers[]` — not just raw text.

### Status via filesystem
`.spindle/status.json` in the working directory. Polled every 2s. No sockets.

### Notifications trigger turns
`pi.sendMessage()` with `deliverAs: "followUp"` and `triggerTurn: true` brings the agent back when a subagent finishes.

### tmux for observability
`/spindle attach w0` to watch any subagent in real time.
