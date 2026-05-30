# Architecture

## Overview

Spindle is a Pi extension that adds deterministic multi-agent workflow orchestration. One tool surface (`spindle`), in-memory subagent sessions, fleet-scale display.

```
user prompt
  → Pi model writes a workflow script
  → spindle tool parses + validates via acorn AST
  → script runs in Node VM sandbox
  → agent() calls spawn in-memory Pi sessions
  → progress streams as sigiled text + fleet widget
  → final result returned to parent assistant
```

## Module layout

```
src/
├── index.ts              Extension entry, tool registration, commands
├── workflow/
│   ├── types.ts           Type definitions (WorkflowRun, AgentDriver, etc.)
│   ├── meta.ts            AST-validated meta parser (acorn)
│   ├── schema.ts          JSON Schema validation + extraction
│   ├── runtime.ts         WorkflowRuntime: VM sandbox, DSL, scheduler
│   ├── library.ts         Discover/resolve/save workflows
│   ├── render.ts          Theme-aware formatting with sigils/progress bars
│   ├── display.ts         Fleet widget, snapshots, status line, streaming display
│   ├── agent-driver.ts    In-memory agent driver (createAgentSession)
│   ├── process-driver.ts  Process-based agent driver (spawns pi --mode json)
│   ├── sessions.ts        Agent session handles (attach/message)
│   └── fleet-panel.ts      Interactive TUI overlay for fleet exploration
├── repl.ts                Persistent Node REPL
├── tools.ts               Tool wrappers (read, edit, write, bash, etc.)
├── builtins.ts            Diff, retry, context/inspection tools
├── agents.ts              Subagent persona discovery
├── workers.ts             Legacy sync subagent (tmux-based)
├── mcp.ts                 MCP client
└── mcp-config.ts          MCP config loader
```

## Key design decisions

### VM sandbox, not eval

Workflow scripts run inside `vm.createContext()` with explicit globals. No `require`, `fs`, `Date.now`, `Math.random`. Deterministic by design.

### AST-validated meta

The `export const meta = { ... }` header is parsed by acorn and evaluated via `evaluateLiteral()` — no `new Function()`, no arbitrary code execution in meta.

### In-memory subagents

`agent()` calls create Pi sessions via `createAgentSession` with `SessionManager.inMemory()`. Full coding tools. No tmux, no process spawning. Structured output uses a `terminate: true` tool.

### Process-based subagents

When the driver mode is set to `process`, agents spawn as `pi --mode json -p --no-session` child processes. Each gets full isolation, its own context window, and all Pi coding tools. Supports attach/messaging via `pi.sendUserMessage` with `deliverAs: 'steer'`. Switch with `/spindle config driver process`.

### Null-on-failure

Agents return `null` on failure instead of throwing. This matches the fan-out/fan-in pattern: `parallel()` and `pipeline()` keep running even when some agents fail, returning `null` for failed slots.

### Fleet widget

When workflows are active, a compact fleet widget renders above the editor. For large agent counts, phases aggregate automatically (no per-agent listing until under threshold).

### Fleet panel

`/spindle workflows` opens an interactive overlay TUI (via `ctx.ui.custom()`) with drill-down navigation: runs → phases → agents → detail. Keyboard controls: ↑↓ navigate, Enter drill-in, Esc back, p pause/resume, x stop, r restart, a attach. Auto-refreshes every 2 seconds.

### Storage

No `.spindle/` directories in project repos. Saved workflows go to `.pi/threads/` (project) or `~/.pi/agent/threads/` (global). Runtime state lives in Pi session entries or XDG state (`~/.local/state/spindle/`).

### Sigils

⏣ done · ◎ running · ○ queued · ✦ failed · ⊘ cancelled · ◈ cached

Block progress bars (█/░) with ▓ for errors.