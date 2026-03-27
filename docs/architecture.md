# Architecture

## Overview

Spindle is a pi extension with two tools (`spindle_exec`, `spindle_status`) and a set of slash commands. Everything goes through the REPL.

```
pi (main session)
├── spindle_exec tool
│   └── Repl (persistent vm context)
│       ├── Tool wrappers (read, edit, bash, grep, ...)
│       ├── File I/O (load, save)
│       ├── spawn() → WorkerHandle
│       ├── llm() → LlmResult
│       ├── MCP builtins
│       └── Utilities (diff, retry, sleep, ...)
├── spindle_status tool
├── /spindle command (attach, list, reset, config)
├── Poller (polls worker status files)
└── Dashboard (setWidget)
```

## Modules

| Module | Purpose |
|--------|---------|
| `index.ts` | Extension entry point. Registers tools, commands, wires builtins. |
| `repl.ts` | Persistent JavaScript VM context with declaration hoisting. |
| `tools.ts` | Tool wrappers (ToolResult), load/save, bash execution. |
| `builtins.ts` | diff, retry, vars/clear context tools. |
| `agents.ts` | Agent discovery from ~/.pi/agent/agents and .pi/agents. |
| `workers.ts` | spawn(), WorkerHandle, git worktree + tmux session lifecycle. |
| `worker-extension.ts` | Lightweight pi extension loaded by worker processes. Writes status files. |
| `poller.ts` | Polls .spindle/status.json files, fires callbacks on state changes. |
| `dashboard.ts` | Renders compact worker status widget for setWidget(). |
| `mcp.ts` | MCP integration via mcporter. |
| `render.ts` | TUI rendering for spindle_exec and spindle_status. |

## Worker Lifecycle

```
1. spawn("task") called in REPL
   │
2. git worktree add .worktrees/w0 -b spindle/w0
   │
3. tmux new-session -d -s spindle-w0 -c .worktrees/w0
   │
4. pi -p --no-session -e worker-extension.ts "Task: ..."
   │  runs in tmux session — full pi with all tools
   │
5. worker-extension.ts hooks events:
   │  tool_execution_start → writes .spindle/status.json
   │  tool_execution_end   → writes .spindle/status.json
   │  turn_end             → writes .spindle/status.json
   │  agent_end            → writes final status, calls ctx.shutdown()
   │
6. Main session poller reads status files every 2s
   │  → updates dashboard widget (ctx.ui.setWidget)
   │  → on completion: pi.sendMessage({ deliverAs: "followUp", triggerTurn: true })
   │
7. Agent collects: r = await h.result
   │
8. Agent merges: bash({ command: `git merge ${h.branch}` })
```

## Key Design Decisions

### Workers are isolated
Each worker gets its own git worktree and tmux session. No shared filesystem, no message passing, no coordination needed during execution. Coordination happens before (code decides who works on what) and after (code merges results).

### The REPL is the sole interface
Everything goes through `spindle_exec`. No separate spawn/collect/status tools. The agent thinks in JavaScript when orchestrating.

### Structured episodes
The worker extension injects an episode prompt via `before_agent_start`, so the agent writes a structured `<episode>` block at the end of its response. The extension parses this on `agent_end` and includes structured findings, artifacts, and blockers in the status file. The orchestrator gets real structured data — not just a text blob.

### Status via filesystem
Workers communicate completion through `.spindle/status.json` files in their worktrees. The main session polls these files. No sockets, no channels — just reading a small JSON file every 2 seconds.

### Notifications trigger agent turns
When a worker finishes, `pi.sendMessage({ deliverAs: "followUp", triggerTurn: true })` injects a message and triggers the agent to take a new turn. The agent can then decide to collect results, merge, or keep working.

### tmux for observability
Workers run in tmux sessions with full pi TUI. Attach with `/spindle attach w0` to watch a worker in real time. No custom UI needed — tmux is the dashboard for detailed observation.
