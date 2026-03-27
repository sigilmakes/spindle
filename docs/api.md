# API Reference

## Tools

Spindle registers two pi tools:

### `spindle_exec`

Execute JavaScript in a persistent REPL.

| Parameter | Type | Description |
|-----------|------|-------------|
| `code` | string | JavaScript code to execute |

### `spindle_status`

Show REPL variables, active workers, usage stats, and configuration. No parameters.

## REPL Builtins

### Tool wrappers

All tool wrappers return `ToolResult { output: string, error: string, ok: boolean, exitCode: number }`. They never throw — errors are captured in the result.

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

`load()` returns a string for files, a `Map<relativePath, content>` for directories. Bypasses the agent's context window.

### Workers

```typescript
spawn(task: string, opts?: SpawnOptions): WorkerHandle
```

Spawns an async worker in a git worktree + tmux session. Returns immediately.

**SpawnOptions:**
```typescript
{
    name?: string;           // Display name
    agent?: string;          // Pre-defined agent name
    model?: string;          // Model override
    tools?: string[];        // Tool whitelist
    timeout?: number;        // Kill after N ms
    worktree?: boolean;      // Use git worktree (default: true)
    systemPromptSuffix?: string;  // Additional system prompt
}
```

**WorkerHandle:**
```typescript
{
    id: string;              // "w0", "w1", ...
    branch: string;          // "spindle/w0"
    worktree: string;        // Absolute path to worktree
    session: string;         // Tmux session name
    task: string;            // Original task description
    startTime: number;       // Timestamp
    status: WorkerStatus;    // "running" | "done" | "crashed"
    result: Promise<WorkerResult>;
    cancel(): Promise<void>;
}
```

**WorkerResult:**
```typescript
{
    status: "success" | "failure";
    summary: string;
    findings: string[];    // key findings or deliverables
    artifacts: string[];   // files created or modified
    blockers: string[];    // what's preventing progress (if blocked)
    branch: string;
    worktree: string;
    exitCode: number;
    turns: number;
    toolCalls: number;
    cost: number;
    model: string;
    durationMs: number;
}
```

### LLM

```typescript
llm(prompt: string, opts?: LlmOptions): Promise<LlmResult>
```

Blocking one-shot subagent. No worktree, no tmux — just spawns a pi process, waits for completion.

**LlmOptions:**
```typescript
{
    agent?: string;
    model?: string;
    tools?: string[];
    timeout?: number;
    maxOutput?: number | false;
}
```

**LlmResult:**
```typescript
{
    text: string;
    cost: number;
    model: string;
    turns: number;
    exitCode: number;
    error?: string;
    ok: boolean;
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
retry<T>(fn: () => Promise<T>, opts?: { attempts?: number; delay?: number; backoff?: number }): Promise<T>
vars(): string[]
clear(name?: string): string
help(): string
```

## Status File Protocol

Workers write `.spindle/status.json` in their worktree:

```json
{
    "status": "running",
    "currentTool": "edit",
    "currentArgs": "src/auth.ts",
    "startTime": 1711540000000,
    "turns": 3,
    "toolCalls": 7,
    "cost": 0.02,
    "model": "claude-sonnet-4-20250514",
    "lastUpdate": 1711540120000
}
```

On completion:

```json
{
    "status": "done",
    "exitCode": 0,
    "summary": "Refactored auth module...",
    "episode": {
        "status": "success",
        "summary": "Refactored auth module to use JWT tokens...",
        "findings": ["Replaced session-based auth with JWT", "Added token refresh endpoint"],
        "artifacts": ["src/auth.ts — rewritten", "src/middleware/jwt.ts — new"],
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
