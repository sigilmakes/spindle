# Spindle Architecture Analysis

## Files Retrieved

1. **src/index.ts** (lines 1-200) - Entry point & orchestrator. Initializes REPL, registers tools, manages session state, threads state through closures.
2. **src/repl.ts** (lines 1-165) - VM-based JS execution sandbox. Clean, focused: context management, code wrapping, timeout/abort handling, output capture.
3. **src/tools.ts** (lines 1-130) - I/O abstraction layer. Wraps pi tools as promises, provides bulk file loading/saving, text extraction helpers.
4. **src/agents.ts** (lines 1-240) - Sub-agent process lifecycle. Discovery, spawning, JSON event parsing, usage tracking, process cleanup.
5. **src/threads.ts** (lines 1-240) - Task orchestration & dispatch. Lazy async generators, work queue with concurrency, real-time updates, episode parsing.
6. **src/render.ts** (lines 1-260) - Display formatting. Theme-aware rendering of code, tool calls, thread states, episodes, stats.

## Key Code

### Data Flow Architecture

```
User Code (JS in REPL)
    ↓
┌─────────────────────┐
│  repl.exec()        │ — VM execution sandbox
├─────────────────────┤
│ Injected Bindings:  │
│  • read, bash, etc. │ ← tools.ts (wrapped pi tools)
│  • load, save       │ ← tools.ts (bulk I/O)
│  • llm()            │ ← agents.ts (spawn sub-agent)
│  • thread()         │ ← threads.ts (create lazy spec)
│  • dispatch()       │ ← threads.ts (run queue)
│  • sleep()          │
└─────────────────────┘
    ↓ [Episodes]
    ↓
┌─────────────────────┐
│ render.ts           │ — Format for display
├─────────────────────┤
│ • formatExecResult  │
│ • formatThreadCol   │
│ • formatEpisodes    │
└─────────────────────┘
```

### ThreadSpec: Lazy Async Generator

```typescript
// From threads.ts
export interface ThreadSpec {
    __brand: "ThreadSpec";
    task: string;
    agent: string;
    opts: ThreadOptions & { defaultCwd: string; defaultModel?: string };
    [Symbol.asyncIterator](): AsyncGenerator<Episode, void, undefined>;
    next(value?: undefined): Promise<IteratorResult<Episode, void>>;
}

// Usage: thread() returns spec, nothing spawns until iterated or dispatched
const spec1 = thread("task 1");
const spec2 = thread("task 2");
const episodes = await dispatch([spec1, spec2]); // ← Both spawn here
```

### Data Flow Through Dispatch

```typescript
export async function dispatchThreads(
    specs: ThreadSpec[],
    concurrency = 4,
    onUpdate?: OnDispatchUpdate,
    signal?: AbortSignal,
): Promise<Episode[]> {
    const states: ThreadState[] = specs.map(...);
    let nextIndex = 0;
    
    const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
            const current = nextIndex++;  // ← Work queue without locks!
            if (current >= specs.length) return;
            
            const spec = specs[current];
            const state = states[current];
            
            const result = await spawnSubAgent(spec.task, ..., onEvent);
            const episode = parseEpisode(result, ...);
            results[current] = episode;
            
            onUpdate?.(states);  // ← Real-time updates
        }
    });
    
    await Promise.all(workers);
    return results;
}
```

### State Threading Pattern (Problematic)

```typescript
// index.ts: spindle_exec execute handler
let currentOnUpdate: AgentToolUpdateCallback<SpindleExecDetails> | undefined;
let currentSignal: AbortSignal | undefined;
let currentCode = string;

async function execute(_toolCallId, params, signal, onUpdate, ctx) {
    currentOnUpdate = onUpdate;
    currentSignal = signal;
    currentCode = params.code;
    
    // Then inside initRepl()...
    r.inject({
        dispatch: async (specs: ThreadSpec[]) => {
            const onDispatchUpdate = (threadStates: ThreadState[]) => {
                if (!onUpdate) return;  // ← Captured from closure!
                onUpdate({
                    content: [...],
                    details: {
                        code,  // ← Captured from closure!
                        threadStates,
                    },
                });
            };
        }
    });
}
```

## Architecture

### Clean Aspects ✓

1. **Strong module separation** — Each file has a single responsibility:
   - `repl.ts`: Execution engine only
   - `tools.ts`: I/O only
   - `agents.ts`: Process lifecycle only
   - `threads.ts`: Orchestration only
   - `render.ts`: Display only

2. **Clear interfaces** — Types define boundaries well:
   - `ThreadSpec` for lazy tasks
   - `Episode` for completed work
   - `ThreadState` for real-time progress
   - `SubAgentResult` for process output

3. **Lazy async generators** — Threads don't spawn until needed. Elegant pattern for building task specs without side effects.

4. **Work queue pattern** — Simple, efficient concurrency control without locks (single-threaded JS).

5. **Event streaming** — Sub-agent events streamed as JSON, accumulated into structured `UsageStats`.

6. **Zero coupling between core modules** — `repl`, `tools`, `agents`, `threads` don't import each other. All orchestration in `index.ts`.

### Issues & Improvements

#### 1. **State Threading via Closures (Risk: Hidden Dependencies)**

**Problem:** `currentOnUpdate`, `currentSignal`, `currentCode` are mutable module-level variables captured in closures. Makes data flow non-obvious.

```typescript
// Current (fragile)
let currentOnUpdate: AgentToolUpdateCallback | undefined;
r.inject({
    dispatch: async (specs) => {
        const onUpdate = currentOnUpdate;  // ← What if cleared elsewhere?
        onUpdate?.(...);
    }
});
```

**Recommendation:** Pass execution context explicitly through inject:

```typescript
// Better
interface ExecContext {
    onUpdate: AgentToolUpdateCallback;
    signal: AbortSignal;
    code: string;
}

r.inject({
    __execContext: execContext,  // ← Single context object
    dispatch: async (specs) => {
        const context = r.getContext().__execContext;
        context.onUpdate?.(...);
    }
});
```

#### 2. **Mixed Concerns in `initRepl()`**

**Problem:** Single function does too much: tool injection, file I/O setup, sub-agent config, threading setup, utilities.

```typescript
// Current: All in one function
function initRepl(workingDir) {
    r.inject(createToolWrappers(cwd));           // ← Tools
    r.inject(createFileIO(cwd));                 // ← File I/O
    r.inject({ llm: async (...) => ... });       // ← Sub-agents
    r.inject({ thread: (...) => ... });          // ← Threading
    r.inject({ dispatch: async (...) => ... });  // ← Dispatch
    r.inject({ sleep: (...) => ... });           // ← Utils
    return r;
}
```

**Recommendation:** Split into setup stages:

```typescript
function initRepl(workingDir, execContext) {
    const r = new Repl();
    r.inject(setupTools(workingDir));
    r.inject(setupFileIO(workingDir));
    r.inject(setupAgentOrchestration(workingDir, execContext));
    r.inject(setupThreading(workingDir, execContext));
    r.inject(setupUtils());
    return r;
}
```

#### 3. **Usage Tracking Scattered**

**Problem:** `cumulativeUsage` incremented in 3 places:
- `llm()` callback (line 50)
- `dispatch()` loop (line 73)
- Results collection (line 78)

```typescript
// Current
cumulativeUsage.totalCost += result.usage.cost;        // llm
cumulativeUsage.totalCost += ep.cost;                  // dispatch
```

**Recommendation:** Centralize via a usage accumulator:

```typescript
class UsageAccumulator {
    add(usage: UsageStats) { /* combine */ }
    getTotal(): UsageStats { /* return */ }
}
```

#### 4. **REPL Context Persistence (Design Choice, Document It)**

**Issue:** Variables persist across separate `spindle_exec` calls. Could be surprising.

```typescript
// Call 1
const x = 123;

// Call 2 (new execution)
console.log(x);  // ← Still 123! Is this intended?
```

**Status:** `repl.reset()` clears it, but default behavior is persistent. Consider:
- Document this clearly in prompt guidelines ✓ (already done)
- Make it configurable? (probably not needed)
- Auto-reset between tool calls? (would break script continuity)

**Verdict:** Design is correct, just needs awareness.

#### 5. **No Structured Error Types**

**Problem:** Errors from sub-agents just returned as strings:

```typescript
// agents.ts
return {
    text: getFinalText(messages),
    error: errorMessage || (exitCode !== 0 ? stderr : undefined),
    // ← Just a string!
};
```

**Better:** Typed error variants:

```typescript
type SubAgentError = 
    | { type: "spawn_failed"; reason: string }
    | { type: "timeout" }
    | { type: "process_error"; exitCode: number; stderr: string }
    | { type: "agent_not_found"; available: string[] };
```

#### 6. **Episode Parsing is Fragile**

**Problem:** Uses regex to extract structured data from freeform text:

```typescript
const block = match[1];
const statusMatch = block.match(/status:\s*(success|failure|blocked)/i);
const summaryMatch = block.match(/summary:\s*(.+?)(?=\nfindings:|\nartifacts:|\nblockers:|\n*$)/is);
```

If agents don't follow format exactly, this breaks silently.

**Recommendation:** 
1. Add validation with helpful errors
2. Consider YAML parsing for more robustness

```typescript
// Better
const lines = block.split('\n');
const parsed = {
    status: extractField(lines, 'status'),
    summary: extractField(lines, 'summary'),
    // ...
};
if (!parsed.status) {
    throw new Error("Episode missing 'status' field");
}
```

#### 7. **Inconsistent Tool Result Abstractions**

**Problem:** `createToolWrappers()` extracts text, but `createFileIO()` returns different shapes:

```typescript
// tools.ts
wrappers[name] = async (args) => {
    const result = await tool.execute(...);
    return extractText(result);  // ← String
};

export async function load(targetPath, cwd) {
    return {
        content: string | Map<string, string>,  // ← Different!
        metadata: { ... }
    };
}
```

**Recommendation:** Unify the abstraction. Either:
- All tools return text (current for wrapped tools) ✓
- All tools return typed results (better for bulk ops)

```typescript
// Option: Keep current (simplest), document in REPL API
// await read({path}) → string (truncated by pi)
// await load({path}) → full content without truncation
```

#### 8. **ThreadSpec Async Iterator Complexity**

**Problem:** Lazy generator with redundant method implementations:

```typescript
export interface ThreadSpec {
    __brand: "ThreadSpec";
    [Symbol.asyncIterator](): AsyncGenerator<Episode, void, undefined>;
    next(value?: undefined): Promise<IteratorResult<Episode, void>>;
    return(value?: void): Promise<IteratorResult<Episode, void>>;
    throw(e?: unknown): Promise<IteratorResult<Episode, void>>;
}
```

The separate `next/return/throw` seem to re-implement `Symbol.asyncIterator`. Why not just use the generator directly?

**Recommendation:** Simplify:

```typescript
// Simpler: Just make it an AsyncGenerator
export type ThreadSpec = AsyncGenerator<Episode, void, undefined> & {
    task: string;
    agent: string;
    opts: ThreadOptions;
};

// Or keep interface but explain the pattern clearly
```

#### 9. **No Concurrency Bounds Enforcement**

**Problem:** Concurrency limit can be set but isn't enforced in validate:

```typescript
dispatchThreads(specs, concurrency, ...);  // ← User could pass 100
```

**Recommendation:** Clamp with clear feedback:

```typescript
const limit = Math.max(1, Math.min(concurrency ?? 4, MAX_CONCURRENCY));
if (concurrency && concurrency > MAX_CONCURRENCY) {
    console.warn(`Concurrency capped to ${MAX_CONCURRENCY}`);
}
```

Already done ✓ (line in threads.ts).

## Start Here

1. **For understanding data flow:** Read `index.ts` first — it's the "conductor" orchestrating all modules.
2. **For adding new tools:** Look at `tools.ts` and how tools are wrapped, then `repl.ts` to see how they're injected.
3. **For multi-agent coordination:** Study `threads.ts` (ThreadSpec pattern, dispatch loop) and `agents.ts` (sub-agent spawning).
4. **For display/UX improvements:** Look at `render.ts` — format functions are independent, easy to modify.

## Summary Table

| Aspect | Status | Priority |
|--------|--------|----------|
| **Module Separation** | ✓ Clean | — |
| **Type Safety** | ✓ Good | — |
| **State Threading** | ⚠ Fragile closures | Medium |
| **Error Handling** | ⚠ Untyped strings | Low |
| **Episode Parsing** | ⚠ Regex-based | Low |
| **Consistency** | ⚠ Mixed abstractions | Low |
| **Concurrency** | ✓ Safe | — |
| **Documentation** | ⚠ Could clarify patterns | Low |

