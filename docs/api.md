# API Reference

## Tools

### `spindle_exec`

Execute JavaScript in a persistent REPL.

| Parameter | Type | Description |
|-----------|------|-------------|
| `code` | string | JavaScript code to execute |

### `spindle_status`

Show REPL variables, active subagents, usage stats, and configuration. No parameters.

## REPL Builtins

### Tool wrappers

All return `ToolResult { output, error, ok, exitCode }`. Never throw.

```typescript
read(args: { path: string; offset?: number; limit?: number }): Promise<ToolResult>
edit(args: { path: string; oldText: string; newText: string }): Promise<ToolResult>
write(args: { path: string; content: string }): Promise<ToolResult>
bash(args: { command: string; timeout?: number }): Promise<ToolResult>
grep(args: { pattern: string; path: string }): Promise<ToolResult>
find(args: { pattern: string; path: string }): Promise<ToolResult>
ls(args: { path: string }): Promise<ToolResult>
```

### File I/O

```typescript
load(path: string): Promise<string | Map<string, string>>
save(path: string, content: string): Promise<void>
```

### subagent()

```typescript
subagent(task: string, opts?: SubagentOptions): SubagentHandle
```

**SubagentOptions:**
```typescript
{
    name?: string;
    agent?: string;           // pre-defined agent name
    model?: string;
    tools?: string[];
    timeout?: number;
    worktree?: boolean;       // default: false
    systemPromptSuffix?: string;
}
```

**SubagentHandle:**
```typescript
{
    id: string;               // "w0", "w1", ...
    task: string;
    session: string;          // tmux session name
    startTime: number;
    branch?: string;          // git branch (if worktree: true)
    worktree?: string;        // worktree path (if worktree: true)
    status: SubagentStatus;   // "running" | "done" | "crashed"
    result: Promise<AgentResult>;
    cancel(): Promise<void>;
}
```

**AgentResult:**
```typescript
{
    // Episode (parsed from agent's <episode> block)
    status: "success" | "failure" | "blocked";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];

    // Raw output
    text: string;
    ok: boolean;

    // Metadata
    cost: number;
    model: string;
    turns: number;
    toolCalls: number;
    durationMs: number;
    exitCode: number;

    // Worktree (undefined when worktree: false)
    branch?: string;
    worktree?: string;
}
```

### MCP

```typescript
mcp(server?: string, opts?: { schema?: boolean }): Promise<...>
mcp_call(server: string, tool: string, args?: object): Promise<ToolResult>
mcp_connect(server: string): Promise<ServerProxy>
mcp_disconnect(server?: string): Promise<void>
```

### Utilities

```typescript
sleep(ms: number): Promise<void>
diff(a: string, b: string, opts?: { context?: number }): string
retry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T>
vars(): string[]
clear(name?: string): string
help(): string
```

## Status File Protocol

The worker extension writes `.spindle/status.json`:

```json
{
    "status": "done",
    "exitCode": 0,
    "summary": "Refactored auth module...",
    "text": "Full raw output...",
    "episode": {
        "status": "success",
        "summary": "Refactored auth module to use JWT...",
        "findings": ["Replaced session auth with JWT", "Added refresh endpoint"],
        "artifacts": ["src/auth.ts", "src/middleware/jwt.ts"],
        "blockers": []
    },
    "startTime": 1711540000000,
    "endTime": 1711540240000,
    "turns": 8,
    "toolCalls": 23,
    "cost": 0.04,
    "model": "claude-sonnet-4-20250514",
    "lastUpdate": 1711540240000
}
```
