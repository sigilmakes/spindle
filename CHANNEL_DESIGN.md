# Channel-Based Message Passing for Spindle Thread Dispatch

## Executive Summary

**Status:** Design Phase  
**Task:** R3 (Channel-Based Message Passing) from Spindle roadmap  
**Scope:** Integration of Unix domain socket channels (from agent-channels package) into thread dispatch for inter-thread messaging during parallel `dispatch()` operations  
**Minimal Viable Implementation:** ~300–400 LOC across 3 files (channels integration + thread APIs + sub-agent tooling)

---

## Foundation: Agent-Channels Package

### What Exists (v0.1.0)

Located at: `~/.pi/packages/pi-channels/packages/agent-channels/`

**Core Components:**
- **`Channel` (channel.ts)** — Unix domain socket server with fan-out messaging
- **`ChannelClient` (client.ts)** — Client to connect and send/receive messages
- **`ChannelGroup` (group.ts)** — Directory-based lifecycle management for sets of channels
- **`Message` interface** — `{ msg: string; data?: Record<string, unknown> }`
- **`FrameDecoder` (framing.ts)** — Length-prefixed JSON frame protocol (4-byte BE uint32 + JSON)

**Key Properties:**
- Self-contained (no pi-channels dependencies)
- Zero runtime dependencies
- Per-message size limit: 16 MB (configurable)
- Stale socket detection and cleanup
- Message queueing for early-arriving clients
- Fan-out with sender exclusion option (can echo back to sender)

### Why It Works for Spindle

1. **No external process overhead.** Unix domain sockets are local IPC — fast, filesystem-based.
2. **Clean message format.** `{msg, data}` is flexible; consumers define semantics.
3. **Lifecycle-managed groups.** `ChannelGroup` handles socket creation, cleanup, `group.json` metadata for discovery.
4. **Proven pattern.** Already used by pi-swarm for agent coordination.
5. **Bridges supported.** TCP bridges enable future distributed Spindle orchestration.

---

## Current Spindle Architecture (Phase 1)

### Thread Dispatch Flow

```
dispatchThreads([threadSpec, threadSpec, ...])
  ├─ create concurrency limiter
  ├─ spawn all subagents in parallel (up to maxConcurrency)
  │   ├─ each agent: pi --mode json -p --no-session
  │   ├─ stream JSON events (tool calls, text)
  │   ├─ collect raw output + usage stats
  │   └─ parse final <episode> block
  ├─ return Episode[] in input order
  └─ no inter-thread communication
```

### Current ThreadSpec/ThreadOptions

```typescript
interface ThreadOptions {
    agent?: string;
    model?: string;
    tools?: string[];
    timeout?: number;
    // channel?: string;  // ← NOT YET IMPLEMENTED
}

interface ThreadSpec extends AsyncGenerator<Episode> {
    task: string;
    agent: string;
    opts: ThreadOptions & { defaultCwd; defaultModel? };
    signal?: AbortSignal;
}
```

### Sub-Agent Spawning

File: `agents.ts` — `spawnSubAgent(task, opts, signal)`

- Creates temp system prompt file
- Spawns: `pi --mode json -p --append-system-prompt <tempfile> --no-session`
- Streams JSON events to callback
- Cleans up temp file on exit
- Returns: `{ text, usage, error?, raw }`

---

## Integration Design: Thread Channels (R3)

### Concept

When `dispatch()` is called with threads that have a `channel` option, Spindle:
1. Creates a `ChannelGroup` for the dispatch
2. Injects socket paths as environment variables to each sub-agent
3. Sub-agents connect as clients and exchange messages during execution
4. Orchestrator can observe/log channel traffic (future: signal threads to pause/resume)
5. Channels are cleaned up when dispatch completes

### Example Usage

```javascript
// Two workers collaborate on implementing a feature
const results = await dispatch([
  thread(
    "Implement the API route handlers. Check 'collab' channel for DB schema updates.",
    { agent: "worker", channel: "collab" }
  ),
  thread(
    "Design and implement the database schema. Send updates to 'collab' channel.",
    { agent: "worker", channel: "collab" }
  ),
])
// Both threads can send/recv on "collab" during execution
```

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Orchestrator (Spindle REPL)                        │
│  dispatchThreads([t1, t2, ...])                     │
│  with opts: { channels: ["collab"] }               │
├─────────────────────────────────────────────────────┤
│  Create ChannelGroup                                │
│  path: /tmp/spindle-dispatch-<pid>-<uuid>/         │
│  channels: [{ name: "collab" }]                     │
│  await group.start()                                │
│  ↓                                                  │
│  Inject into each sub-agent subprocess:             │
│    SPINDLE_CHANNELS_PATH=/tmp/spindle-dispatch-XXX │
│    SPINDLE_CHANNEL_NAMES=collab                    │
│    SPINDLE_THREAD_ID=t1 (or t2, etc.)              │
│                                                     │
│  ┌──────────────────┐  ┌──────────────────┐        │
│  │ Thread t1        │  │ Thread t2        │        │
│  │ pi --mode json   │  │ pi --mode json   │        │
│  │ Extensions: ...  │  │ Extensions: ...  │        │
│  │ + spindle        │  │ + spindle        │        │
│  │                  │  │                  │        │
│  │ REPL injects:    │  │ REPL injects:    │        │
│  │  send(ch, msg)   │  │  send(ch, msg)   │        │
│  │  recv(ch)        │  │  recv(ch)        │        │
│  │                  │  │                  │        │
│  │ ChannelClient    │──┤ ChannelClient    │        │
│  │ connected to     │  │ connected to     │        │
│  │ collab.sock      │  │ collab.sock      │        │
│  └──────────────────┘  └──────────────────┘        │
│         ↕                      ↕                   │
│    collab.sock (fan-out)                          │
│                                                     │
│  Optionally monitor channel traffic (future):      │
│  channel.on("message", (msg, clientId) => {})     │
└─────────────────────────────────────────────────────┘
```

### File Structure for Integration

```
spindle/
├── index.ts              ← dispatch() updated for channels
├── threads.ts            ← ThreadOptions.channel added
├── channels/
│   ├── index.ts          ← exports from agent-channels
│   ├── integration.ts    ← ChannelGroup lifecycle (create, cleanup)
│   ├── client.ts         ← re-export from agent-channels
│   ├── channel.ts        ← re-export from agent-channels
│   ├── framing.ts        ← re-export from agent-channels
│   └── message.ts        ← re-export from agent-channels
├── render.ts             ← channel traffic logging (future)
└── agents.ts             ← updated: pass channel env vars to sub-agents
```

Actually, simpler: **no separate channels/ directory**. Just:
- Import from `agent-channels` package
- Create integration utilities inline in `threads.ts` or new `channels-integration.ts`
- Spindle owns the dispatch-side logic, agent-channels handles the IPC layer

---

## Minimal Viable Implementation (MVI)

### Phase 3a: Basic Channel Injection (1 file, ~150 LOC)

**File: `channels-integration.ts`** (new)

Responsibilities:
- Create a ChannelGroup for a dispatch operation
- Generate socket paths for each channel name
- Provide cleanup function
- Export: `createChannelGroup(names: string[], pid?: string)` + `ChannelGroupHandle`

```typescript
import { ChannelGroup, type ChannelGroupOptions } from "agent-channels";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

export interface ChannelGroupHandle {
  group: ChannelGroup;
  path: string;
  channelNames: string[];
  socketPaths: Map<string, string>;  // name -> /path/to/name.sock
  cleanup(): Promise<void>;
}

export async function createChannelGroup(
  channelNames: string[],
  pid?: string
): Promise<ChannelGroupHandle> {
  const dispatchId = `${pid || process.pid}-${Date.now()}`;
  const groupPath = path.join(os.tmpdir(), `spindle-channels-${dispatchId}`);

  const group = new ChannelGroup({
    path: groupPath,
    channels: channelNames.map((name) => ({ name })),
  });

  await group.start();

  const socketPaths = new Map<string, string>();
  for (const name of channelNames) {
    socketPaths.set(name, path.join(groupPath, `${name}.sock`));
  }

  return {
    group,
    path: groupPath,
    channelNames,
    socketPaths,
    cleanup: () => group.stop({ removeDir: true }),
  };
}
```

### Phase 3b: Update ThreadOptions & dispatch() (2 files, ~100 LOC)

**File: `threads.ts`** — Add to ThreadOptions:

```typescript
export interface ThreadOptions {
  agent?: string;
  model?: string;
  tools?: string[];
  timeout?: number;
  channel?: string | string[];  // ← new: channel(s) this thread uses
}
```

**File: `index.ts`** — Update dispatchThreads call site:

```typescript
const dispatch = async (threads: ThreadSpec[]) => {
  // Extract unique channel names from all threads
  const channelSet = new Set<string>();
  for (const t of threads) {
    if (t.opts.channel) {
      const names = Array.isArray(t.opts.channel) ? t.opts.channel : [t.opts.channel];
      names.forEach(n => channelSet.add(n));
    }
  }
  const channels = Array.from(channelSet);

  // Create channel group if needed
  let handle: ChannelGroupHandle | null = null;
  if (channels.length > 0) {
    handle = await createChannelGroup(channels);
  }

  try {
    // Pass channel paths via env to each thread that requested a channel
    const results = await dispatchThreads(threads, {
      channelGroup: handle,  // ← new param
      onUpdate: currentOnUpdate,
      signal: currentSignal,
    });
    return results;
  } finally {
    if (handle) {
      await handle.cleanup();
    }
  }
};
```

### Phase 3c: Sub-Agent Channel Integration (1 file, ~200 LOC)

**File: `agents.ts`** — Update spawnSubAgent:

```typescript
interface SpawnSubAgentOptions {
  agent?: string;
  model?: string;
  tools?: string[];
  timeout?: number;
  systemPromptSuffix?: string;
  defaultCwd: string;
  defaultModel?: string;
  // NEW:
  channelPaths?: Map<string, string>;  // channel name -> socket path
  threadId?: string;                   // unique ID for this thread
}

async function spawnSubAgent(
  task: string,
  opts: SpawnSubAgentOptions,
  signal?: AbortSignal
): Promise<SubAgentResult> {
  // ... existing code ...

  const env = {
    ...process.env,
  };

  // Inject channel info if available
  if (opts.channelPaths && opts.channelPaths.size > 0) {
    env.SPINDLE_CHANNELS = JSON.stringify(
      Object.fromEntries(opts.channelPaths)  // { "collab": "/tmp/.../collab.sock", ... }
    );
    env.SPINDLE_THREAD_ID = opts.threadId || "anonymous";
  }

  const subprocess = spawn("pi", [...piArgs], {
    cwd: opts.defaultCwd,
    env,
    // ... rest of spawn options ...
  });

  // ... rest of implementation ...
}
```

### Phase 3d: REPL Injection for Sub-Agents (~100 LOC)

**File: `repl.ts`** — When a sub-agent's Spindle REPL starts with channel env vars:

```typescript
// At initialization in a sub-agent's REPL context:
const channelsJson = process.env.SPINDLE_CHANNELS;
const threadId = process.env.SPINDLE_THREAD_ID;

if (channelsJson && threadId) {
  const channels: Record<string, string> = JSON.parse(channelsJson);
  const clients: Map<string, ChannelClient> = new Map();

  // Lazy connect on first use
  const getClient = async (channelName: string): Promise<ChannelClient> => {
    if (clients.has(channelName)) {
      return clients.get(channelName)!;
    }
    const socketPath = channels[channelName];
    if (!socketPath) {
      throw new Error(`Channel "${channelName}" not available to this thread`);
    }
    const client = new ChannelClient(socketPath);
    await client.connect();
    clients.set(channelName, client);
    return client;
  };

  // Inject send() and recv() as REPL functions
  r.inject({
    send: async (channelName: string, msg: string, data?: Record<string, unknown>) => {
      const client = await getClient(channelName);
      client.send({ msg, data: { ...data, from: threadId } });
    },

    recv: async (channelName: string): Promise<string> => {
      const client = await getClient(channelName);
      return new Promise((resolve) => {
        const handler = (msg: Message) => {
          client.removeListener("message", handler);
          resolve(msg.msg);
        };
        client.on("message", handler);
      });
    },

    // Cleanup on REPL exit
    _cleanup: async () => {
      for (const client of clients.values()) {
        client.disconnect();
      }
    },
  });
}
```

---

## Integration with Thread Dispatch

### Updated dispatchThreads Signature

```typescript
export interface DispatchOptions {
  channelGroup?: ChannelGroupHandle;
  onUpdate?: AgentToolUpdateCallback<...>;
  signal?: AbortSignal;
}

export async function dispatchThreads(
  specs: ThreadSpec[],
  opts: DispatchOptions
): Promise<Episode[]> {
  const { channelGroup, onUpdate, signal } = opts;

  // For each thread, if it requested channels and we have a group:
  for (const spec of specs) {
    const channel = spec.opts.channel;
    if (channel && channelGroup) {
      const names = Array.isArray(channel) ? channel : [channel];
      spec.opts.channelPaths = channelGroup.socketPaths;
      spec.opts.threadId = `${spec.agent}-${spec.index}`;  // or UUID
    }
  }

  // Spawn as normal, but with channel env vars injected
  // ... rest of dispatch logic ...
}
```

---

## Minimal Viable API for Orchestrators

### In the Spindle REPL

```javascript
// Scenario 1: Single channel, multiple threads
const results = await dispatch([
  thread("Research the architecture", { agent: "scout", channel: "research" }),
  thread("Design based on research updates", { agent: "scout", channel: "research" }),
])

// Scenario 2: Multiple channels
const results = await dispatch([
  thread("Implement API", { agent: "worker", channel: ["api", "shared"] }),
  thread("Implement tests", { agent: "worker", channel: ["tests", "shared"] }),
])

// Scenario 3: No channels (existing behavior)
const results = await dispatch([
  thread("Task A", { agent: "scout" }),
  thread("Task B", { agent: "scout" }),
])
```

### Inside a Thread (Sub-Agent REPL)

```javascript
// Send a message to a channel
await send("collab", "Updated user schema to include OAuth2 fields");

// Receive a message from a channel (blocks until one arrives)
const msg = await recv("collab");
console.log("Partner says:", msg);

// Broadcast to all channels the thread is on
await send("api", "API routes are ready for testing");
await send("shared", "Checkpoint: finished phase 1");
```

---

## Minimal Viable Testing

### Unit Test: Channel Creation & Cleanup

```typescript
it("creates and cleans up channel group", async () => {
  const handle = await createChannelGroup(["test1", "test2"]);
  expect(handle.group.started).toBe(true);
  expect(handle.channelNames).toEqual(["test1", "test2"]);

  await handle.cleanup();
  // Socket files removed, group.json cleaned up
});
```

### Integration Test: Two Threads on a Channel

```typescript
it("allows two threads to message each other", async () => {
  const results = await dispatch([
    thread("Send a message via llm", {
      agent: "worker",
      channel: "test",
      // In the thread's code:
      // await send("test", "hello from thread 1");
      // const reply = await recv("test");
    }),
    thread("Listen and reply", {
      agent: "worker",
      channel: "test",
      // In the thread's code:
      // const msg = await recv("test");
      // await send("test", "got it: " + msg);
    }),
  ]);
  // Verify both threads completed successfully
  expect(results.every(e => e.status === "success")).toBe(true);
});
```

---

## Decision Points & Tradeoffs

### 1. Channel Naming & Scoping

**Decision:** Thread-local channels (each dispatch gets its own `ChannelGroup`).

**Why:**
- Isolates concurrent dispatches (no cross-dispatch interference)
- Automatic cleanup on dispatch completion
- Prevents socket leaks and port conflicts
- Simplifies testing (no global socket state)

**Alternative:** Global channel server. **Rejected** — lifecycle management becomes complex; threads from different dispatches could accidentally message.

### 2. Lazy Client Connection vs. Eager

**Decision:** Lazy connection (on first `send()`/`recv()` call).

**Why:**
- Faster REPL startup for threads not using channels
- No connection errors until channel use is attempted
- Simpler error handling (no connection state to manage upfront)

**Tradeoff:** First `send()`/`recv()` has startup latency (socket connect).

### 3. recv() Blocking Semantics

**Decision:** `recv()` blocks until a message arrives, no timeout by default.

**Why:**
- Matches Unix IPC blocking semantics
- Simple semantics for orchestrators
- If a thread hangs on `recv()`, it gets killed by thread timeout anyway

**Future Enhancement:** `recvTimeout(ch, ms)` with configurable timeout.

### 4. Error Propagation

**Decision:** `send()`/`recv()` throw on socket errors, connect failures.

**Why:**
- Explicit error handling in agent code
- Thread's episode captures the failure
- Orchestrator can see which threads failed and why

### 5. Socket Path Injection Method

**Decision:** Environment variables `SPINDLE_CHANNELS` (JSON) + `SPINDLE_THREAD_ID`.

**Why:**
- No need to modify sub-agent's command-line args
- Sub-agent Spindle REPL can read and inject automatically
- Clean separation: orchestrator sets env, REPL detects it

**Alternative:** Command-line flag `--spindle-channels '{"name":"/path"}'`. **Rejected** — harder to escape, less discoverable.

---

## Future Extensions (Post-MVI)

### R3a: Channel Observe Mode (Orchestrator)

```typescript
const handle = await createChannelGroup(["collab"]);
const channel = handle.group.channel("collab");
channel.on("message", (msg, clientId) => {
  console.log(`[${clientId}] ${msg.msg}`);
});
```

### R3b: Barrier Primitive (Wait for All Threads)

```javascript
// Inside a thread:
await barrier("collab");  // Wait until all threads on "collab" reach this point
```

Requires bidirectional signalling (orchestrator ↔ sub-agent). Defer to R1 (Stepped Threads).

### R3c: Gather Primitive (Collect from All)

```javascript
// Inside a thread:
const values = await gather("collab", "my_status");  // Collect one value from each thread
```

### R3d: TCP Bridges for Distributed Dispatch

Spin up sub-orchestrators on other machines, bridge their channels to the parent via TCP.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Socket path conflicts | Use tmpdir + pid + timestamp; verify on start with stale socket detection |
| Hanging recv() | Thread timeout (already exists) catches it |
| Message loss if client connects late | ChannelGroup queues messages until first client arrives |
| Orphaned sockets on crash | Stale socket detection on next start; cleanup on dispatch end |
| Large message sizes | 16 MB limit enforced by FrameDecoder |
| Race condition: channel cleanup before last message | Orchestrator waits for all threads to finish before cleanup |

---

## Implementation Checklist (MVI)

- [ ] **1. Create `channels-integration.ts`**
  - [ ] `createChannelGroup()` — create ChannelGroup and return handle
  - [ ] `ChannelGroupHandle` interface
  - [ ] Cleanup logic

- [ ] **2. Update `threads.ts`**
  - [ ] Add `channel?: string | string[]` to `ThreadOptions`
  - [ ] Pass `channel` through to sub-agent spawning

- [ ] **3. Update `agents.ts`**
  - [ ] Add `channelPaths`, `threadId` to `SpawnSubAgentOptions`
  - [ ] Inject `SPINDLE_CHANNELS` and `SPINDLE_THREAD_ID` env vars
  - [ ] Pass through to subprocess

- [ ] **4. Update `repl.ts`**
  - [ ] Detect channel env vars at REPL init
  - [ ] Lazy-connect `ChannelClient` instances
  - [ ] Inject `send()`, `recv()` functions
  - [ ] Cleanup on REPL shutdown

- [ ] **5. Update `index.ts`**
  - [ ] Create channel group before dispatch if any thread has `.channel`
  - [ ] Pass `channelGroup` to `dispatchThreads()`
  - [ ] Cleanup after dispatch

- [ ] **6. Unit tests** for channel creation/cleanup

- [ ] **7. Integration test** with two threads messaging

---

## Code Size Estimate

| File | LOC | Purpose |
|------|-----|---------|
| channels-integration.ts (new) | 60–80 | Channel group lifecycle |
| threads.ts (update) | +15 | Add `channel` to `ThreadOptions` |
| agents.ts (update) | +40–50 | Env var injection |
| repl.ts (update) | +80–100 | Client connect, send/recv injection |
| index.ts (update) | +30–50 | Channel group creation/cleanup in dispatch |
| tests (new) | 100–150 | Unit + integration |
| **Total new code** | **325–425** | |

---

## Related Documentation

- Agent-Channels README: `~/.pi/packages/pi-channels/packages/agent-channels/README.md`
- Channel API types: `~/.pi/packages/pi-channels/packages/agent-channels/src/`
- Spindle Roadmap item R3: `scratchpad/plans/2026-03-15-spindle-extension.md`

