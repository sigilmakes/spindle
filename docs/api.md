# API Reference

## Tools

### `spindle_exec`

Execute JavaScript in a persistent runtime with a proper Node environment.

| Parameter | Type | Description |
|-----------|------|-------------|
| `code` | string | JavaScript code to execute |

Notes:
- `require`, `process`, `Buffer`, `globalThis`, and dynamic `import()` are available
- runtime variables persist across calls
- after each call, `_last*` inspection variables are updated

### `spindle_status`

Show runtime variables, usage stats, and configuration. No parameters.

## Runtime Builtins

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

### `subagent()`

```typescript
subagent(task: string, opts?: SubagentOptions): Promise<AgentResult>
```

Runs a child agent call **synchronously** and returns `AgentResult` directly.

**SubagentOptions:**
```typescript
{
    name?: string;
    agent?: string;
    model?: string;
    tools?: string[];
    timeout?: number;
    worktree?: boolean;
    systemPromptSuffix?: string;
}
```

**AgentResult:**
```typescript
{
    status: "success" | "failure" | "blocked";
    summary: string;
    findings: string[];
    artifacts: string[];
    blockers: string[];
    text: string;
    ok: boolean;
    cost: number;
    model: string;
    turns: number;
    toolCalls: number;
    durationMs: number;
    exitCode: number;
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
inspectVar(name: string, opts?: { depth?: number; maxChars?: number }): string
keys(valueOrName: unknown, opts?: { limit?: number }): string[]
shape(valueOrName: unknown): Record<string, unknown>
sample(valueOrName: unknown, n?: number): unknown
preview(valueOrName: unknown, opts?: { maxChars?: number }): string
help(): string
```

## Automatic last-result variables

After every `spindle_exec` call, the runtime updates:

```typescript
_last
_lastValue
_lastResult
_lastOutput
_lastFullOutput
_lastError
_lastDurationMs
_lastStatus
_lastTruncated
```

These are especially useful when output is truncated.

## Runtime result status

`Repl.exec()` normalizes outcomes with a status field:

```typescript
type ExecStatus =
    | "ok"
    | "aborted_by_user"
    | "runtime_error"
    | "process_terminated";
```

This status is exposed in `spindle_exec` details and mirrored into `_lastStatus`.
