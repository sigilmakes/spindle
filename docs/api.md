# API Reference

## Tool: `spindle`

One tool covers Spindle's runtime and thread engine.

```ts
spindle({ code?: string, name?: string, script?: string, scriptPath?: string, args?: unknown, inspect?: "status" | "threads" })
```

Use:

- `{ code }` — run scratch orchestration code. Plain code uses the persistent Node runtime; code using thread DSL helpers runs as a rich thread.
- `{ name, args }` — run a saved thread from `.pi/threads` or `~/.pi/agent/threads`.
- `{ script, args }` — run an inline thread script.
- `{ scriptPath, args }` — run a thread file.
- `{ inspect: "status" }` — show runtime, usage, and config.
- `{ inspect: "threads" }` — list saved threads and recent runs.

## Thread DSL

Thread scripts may export metadata:

```ts
export const meta = {
    name: "review",
    description: "Parallel review",
    phases: [{ title: "Scan" }, { title: "Review" }],
}
```

Available inside threads:

```ts
phase(title: string): void
log(message: string, data?: unknown): void
agent(prompt: string, opts?: ThreadAgentOptions): Promise<AgentResult | unknown>
subagent(prompt: string, opts?: ThreadAgentOptions): Promise<AgentResult | unknown>
parallel<T>(thunks: Array<() => Promise<T> | T>, opts?: { concurrency?: number }): Promise<T[]>
pipeline<T>(items: T[], ...stages: Array<(prev: unknown, item: T, index: number) => unknown>): Promise<unknown[]>
thread(nameOrPath: string, args?: unknown): Promise<unknown>
answer.done(value: unknown): unknown
args: unknown
context: unknown
```

`agent()` options extend `SubagentOptions`:

```ts
{
    label?: string;
    phase?: string;
    schema?: JsonSchema;
    retries?: number;
    cache?: "auto" | "force" | "skip";
    agent?: string;
    model?: string;
    tools?: string[];
    timeout?: number;
    worktree?: boolean;
    name?: string;
    systemPromptSuffix?: string;
}
```

When `schema` is supplied, Spindle asks the child agent for a `<structured>` JSON block and validates it.

## Runtime builtins

Plain orchestration code has a persistent Node-flavored scope:

- `require`, `process`, `Buffer`, `globalThis`, dynamic `import()`
- persistent variables across calls
- top-level `const` / `let` / `var` hoisted into persistent assignments

### Tool wrappers

All return `ToolResult { output, error, ok, exitCode }`. They do not throw.

```ts
read(args): Promise<ToolResult>
edit({ path, oldText, newText }): Promise<ToolResult>
write(args): Promise<ToolResult>
bash({ command, timeout? }): Promise<ToolResult>
grep(args): Promise<ToolResult>
find(args): Promise<ToolResult>
ls(args): Promise<ToolResult>
```

### File I/O

```ts
load(path: string): Promise<string | Map<string, string>>
save(path: string, content: string): Promise<void>
```

### Subagents

```ts
subagent(task: string, opts?: SubagentOptions): Promise<AgentResult>
```

Runs a child agent synchronously.

### MCP

```ts
mcp(server?: string, opts?: { schema?: boolean }): Promise<...>
mcp_call(server: string, tool: string, args?: object): Promise<ToolResult>
mcp_connect(server: string): Promise<ServerProxy>
mcp_disconnect(server?: string): Promise<void>
```

### Utilities

```ts
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

After every plain code call, the runtime updates:

```ts
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
