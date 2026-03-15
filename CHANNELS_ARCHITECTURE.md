# Spindle Channel Integration - Visual Architecture

## High-Level Data Flow

```
┌─ Orchestrator (Spindle REPL) ──────────────────────────────┐
│                                                             │
│  dispatch([                                                │
│    thread("API work", { channel: "collab" }),             │
│    thread("DB work", { channel: "collab" }),              │
│  ])                                                        │
│                                                             │
│  ▼ createChannelGroup(["collab"])                         │
│    • Create /tmp/spindle-channels-<pid>-<time>/           │
│    • Start ChannelGroup with [{ name: "collab" }]         │
│    • Channels listen on Unix domain sockets                │
│    • Return ChannelGroupHandle with paths                  │
│                                                             │
│  ▼ dispatchThreads(specs, { channelGroup })              │
│    For each thread that requested channels:                │
│    • Set SPINDLE_CHANNELS={...socket paths...}            │
│    • Set SPINDLE_THREAD_ID="worker-1"                     │
│    • Spawn: pi --mode json -p --no-session                │
│                                                             │
└────────────────────────────────────────────────────────────┘
         ▲                                   ▼
         │           ┌──────────────────────┬──────────────────────┐
         │           ▼                      ▼                      ▼
      Episode    ┌─────────────┐        ┌─────────────┐        ┌─────────────┐
      (final)    │ Thread 1    │        │ Thread 2    │        │ Thread 3    │
      + cost     │ pi process  │        │ pi process  │        │ pi process  │
      + findings │             │        │             │        │             │
      + raw text │ Spindle     │        │ Spindle     │        │ Spindle     │
                 │ REPL        │        │ REPL        │        │ REPL        │
                 │             │        │             │        │             │
                 │ send/recv   │        │ send/recv   │        │ send/recv   │
                 │ injected    │        │ injected    │        │ injected    │
                 │             │        │             │        │             │
                 │ ChannelClient       │ ChannelClient       │ ChannelClient
                 │ (lazy connect)      │ (lazy connect)      │ (lazy connect)
                 └────────┬────┘        └────────┬────┘        └────────┬────┘
                          │                     │                     │
                          └─────────────┬───────┴───────┬──────────────┘
                                        │               │
                                /tmp/spindle-channels-XXX/
                                ├─ collab.sock ◄─ fan-out messages
                                ├─ group.json
                                └─ (cleanup on dispatch end)
```

---

## Socket Architecture (Detail)

```
Unix Domain Socket: /tmp/spindle-channels-12345-1710520123/collab.sock

┌─ Channel (Server) ─────────────────────────────────────────┐
│                                                            │
│  listener socket: collab.sock                             │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ Message Queue (for early-arriving messages)          │ │
│  │  [{ msg: "...", data: {...} }, ...]                 │ │
│  └──────────────────────────────────────────────────────┘ │
│                    ▲                                      │
│          (filled before clients connect)                 │
│                                                            │
│  Connected Clients Map:                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐           │
│  │ client-0 │    │ client-1 │    │ client-2 │           │
│  │ worker-1 │    │ worker-2 │    │ worker-3 │           │
│  └──┬───────┘    └──┬───────┘    └──┬───────┘           │
│     │               │               │                   │
│  [socket]        [socket]        [socket]               │
│     ▲               ▲               ▲                   │
│     │ (fan-out)     │ (fan-out)     │ (fan-out)        │
│     └───────────────┴───────────────┘                   │
│                     ▲                                    │
│          When any client sends:                         │
│          - Extract msg from sender                      │
│          - Broadcast to all EXCEPT sender               │
│            (unless echoToSender: true)                  │
└──────────────────────────────────────────────────────────┘
```

---

## Message Flow Sequence

### Scenario: Two Workers Collaborating

```
Time  Orchestrator              Thread 1 (API)        Thread 2 (DB)        Channel
                                                                             (collab)
─────────────────────────────────────────────────────────────────────────────────

T0    createChannelGroup("collab")
      ✓ /tmp/spindle-ch.../collab.sock starts
      
T1    spawn Thread 1 ─────────────────────────────────────────────►
      env: SPINDLE_CHANNELS={collab: /tmp/...}
      env: SPINDLE_THREAD_ID=worker-1
      
T2    spawn Thread 2 ─────────────────────────────────────────────────────►
      env: SPINDLE_CHANNELS={collab: /tmp/...}
      env: SPINDLE_THREAD_ID=worker-2

T3                            REPL init
                              detect SPINDLE_CHANNELS
                              inject send/recv
                              ◄─ ChannelClient.connect()
                              ✓ connected as client-0
                              
T4                                                    REPL init
                                                      detect SPINDLE_CHANNELS
                                                      inject send/recv
                                                      ◄─ ChannelClient.connect()
                                                      ✓ connected as client-1

T5                            "Designing REST routes"
                              ◄─ send("collab", "REST schema ready")
                              ─────────────────────────►
                              Channel receives from client-0
                              Fan-out to client-1 (exclude sender)
                              
T6                                                    ◄───── recv("collab")
                                                      blocks waiting...
                                                      ✓ receives: "REST schema ready"
                                                      Excellent! Starting queries.
                                                      send("collab", "DB ready")
                                                      ─────────────────────►
                              
T7                            ◄───── recv("collab")
                              blocks waiting...
                              ✓ receives: "DB ready"
                              Great! Starting integration tests.

T8    ... threads continue working, messaging as needed ...

T9                            finish, return Episode             finish, return Episode
      ◄──────────────────────────────────────────────────────

T10   cleanup()
      Channel stops, sockets closed
      /tmp/spindle-ch.../ removed
```

---

## File Changes (MVI Implementation)

### 1. NEW: channels-integration.ts

```typescript
export interface ChannelGroupHandle {
  group: ChannelGroup
  path: string
  channelNames: string[]
  socketPaths: Map<string, string>
  cleanup(): Promise<void>
}

export async function createChannelGroup(
  channelNames: string[],
  pid?: string
): Promise<ChannelGroupHandle>
```

**Imports from agent-channels:**
```typescript
import { ChannelGroup } from "agent-channels"
```

---

### 2. MODIFY: threads.ts

```typescript
export interface ThreadOptions {
  agent?: string
  model?: string
  tools?: string[]
  timeout?: number
  channel?: string | string[]  // ◄─ NEW
}
```

---

### 3. MODIFY: agents.ts

```typescript
interface SpawnSubAgentOptions {
  // ... existing ...
  channelPaths?: Map<string, string>  // ◄─ NEW
  threadId?: string                   // ◄─ NEW
}

async function spawnSubAgent(
  task: string,
  opts: SpawnSubAgentOptions,
  signal?: AbortSignal
) {
  // ... existing code ...
  
  const env = { ...process.env }
  if (opts.channelPaths?.size > 0) {
    env.SPINDLE_CHANNELS = JSON.stringify(
      Object.fromEntries(opts.channelPaths)
    )
    env.SPINDLE_THREAD_ID = opts.threadId || "anonymous"
  }
  
  // ... pass env to subprocess ...
}
```

---

### 4. MODIFY: repl.ts

```typescript
export function initializeRepl(ctx: ReplContext): Repl {
  const r = new Repl()
  
  // ... existing tool injections ...
  
  // NEW: Channel initialization
  const channelsJson = process.env.SPINDLE_CHANNELS
  const threadId = process.env.SPINDLE_THREAD_ID
  
  if (channelsJson && threadId) {
    const channels: Record<string, string> = JSON.parse(channelsJson)
    const clients: Map<string, ChannelClient> = new Map()
    
    r.inject({
      send: async (channelName: string, msg: string, data?: Record<string, unknown>) => {
        const client = await getOrConnectClient(channelName)
        client.send({ msg, data: { ...data, from: threadId } })
      },
      
      recv: async (channelName: string): Promise<string> => {
        const client = await getOrConnectClient(channelName)
        return new Promise((resolve) => {
          const handler = (msg: Message) => {
            client.removeListener("message", handler)
            resolve(msg.msg)
          }
          client.on("message", handler)
        })
      },
    })
    
    // Cleanup on shutdown
    r.on("shutdown", async () => {
      for (const client of clients.values()) {
        client.disconnect()
      }
    })
  }
  
  return r
}
```

**Imports from agent-channels:**
```typescript
import { ChannelClient, type Message } from "agent-channels"
```

---

### 5. MODIFY: index.ts

```typescript
const dispatch = async (threads: ThreadSpec[]) => {
  // Extract unique channel names
  const channelSet = new Set<string>()
  for (const t of threads) {
    if (t.opts.channel) {
      const names = Array.isArray(t.opts.channel) ? t.opts.channel : [t.opts.channel]
      names.forEach(n => channelSet.add(n))
    }
  }
  const channels = Array.from(channelSet)
  
  // Create channel group if needed
  let handle: ChannelGroupHandle | null = null
  if (channels.length > 0) {
    handle = await createChannelGroup(channels)
  }
  
  try {
    // Pass channel info to dispatchThreads
    const results = await dispatchThreads(threads, {
      channelGroup: handle,
      onUpdate: currentOnUpdate,
      signal: currentSignal,
    })
    return results
  } finally {
    if (handle) {
      await handle.cleanup()
    }
  }
}
```

---

## Dependency Graph

```
index.ts (dispatch entry point)
  ├─ threads.ts (thread creation + dispatch)
  │   ├─ agents.ts (sub-agent spawning)
  │   └─ repl.ts (sub-agent's REPL)
  │       └─ agent-channels (ChannelClient)
  ├─ channels-integration.ts (group lifecycle)
  │   └─ agent-channels (ChannelGroup)
  └─ agents.ts (updated for env var injection)

External dependency: agent-channels v0.1.0+
  ├─ ChannelGroup
  ├─ ChannelClient
  ├─ Channel
  ├─ Message
  └─ encode/FrameDecoder
```

---

## Testing Strategy

### Unit Tests

1. **ChannelGroupHandle creation & cleanup**
   ```
   createChannelGroup() ✓
   - creates directory
   - starts ChannelGroup
   - returns handle with socketPaths
   - cleanup removes sockets and directory
   ```

2. **Environment variable injection**
   ```
   spawnSubAgent with channels ✓
   - SPINDLE_CHANNELS env set correctly
   - SPINDLE_THREAD_ID env set
   - sub-process receives env
   ```

3. **REPL channel detection**
   ```
   Repl.init with SPINDLE_CHANNELS ✓
   - detects env vars
   - injects send/recv functions
   - lazy connects on first use
   ```

### Integration Tests

1. **Two threads on one channel**
   ```
   dispatch with 2 threads, both on "collab" ✓
   - both connect to collab.sock
   - Thread 1 sends, Thread 2 receives
   - Thread 2 sends, Thread 1 receives
   - both finish successfully
   - channel cleaned up
   ```

2. **Three threads on multiple channels**
   ```
   dispatch with 3 threads on ["api", "shared"] ✓
   - creates 2 channels
   - each thread connects to its requested channels
   - messages flow correctly
   - cleanup removes both channels
   ```

3. **No channels (backward compat)**
   ```
   dispatch with threads that don't use channels ✓
   - no ChannelGroup created
   - threads dispatch normally
   - no env vars injected
   - works as before
   ```

---

## Error Scenarios

### Socket Connection Fails

```javascript
// Thread tries to send on non-existent channel
await send("missing-channel", "hello")
// ✗ Throws: Channel "missing-channel" not available to this thread
// ✓ Episode captures error
// ✓ Orchestrator sees thread failed
```

### Socket Path Not Set

```javascript
// Thread's REPL has no SPINDLE_CHANNELS
await send("collab", "hello")
// ✗ Throws: send() not available
// ✓ Episode captures error
```

### recv() Timeout (via thread timeout)

```javascript
// Thread calls recv() but no message arrives
await recv("collab")
// ... blocks ...
// Thread hits its timeout (default from thread opts)
// ✗ Process killed
// ✓ Episode status: "blocked" or "failure"
```

### Channel Cleanup Race

```javascript
// Orchestrator cleans up channels before all threads finish
// ... shouldn't happen because:
// - orchestrator waits for all threads to complete
// - dispatch() doesn't return until all episodes received
// - then cleanup() runs
```

---

## Performance Characteristics

### Latency

| Operation | Typical Latency | Notes |
|-----------|-----------------|-------|
| `send()` | 0.5–2ms | Local Unix socket, write to buffer |
| `recv()` | 0.5–2ms + wait time | Event listener on socket data |
| Channel create | 10–50ms | ChannelGroup.start() |
| Channel cleanup | 5–20ms | Close sockets, remove files |

### Memory

| Component | Typical Size | Notes |
|-----------|--------------|-------|
| ChannelGroup | ~1 MB | Per dispatch (negligible) |
| Message queue | ~100 KB | Default max 1000 messages |
| ChannelClient | ~50 KB | Per connected thread |

### Scalability

- **Max threads per dispatch:** Limited by system ulimit (sockets). Default 4–8 concurrent.
- **Max message size:** 16 MB per message (FrameDecoder limit).
- **Max messages per channel:** Unbounded (OS socket buffers + message queue).
- **Max channels per dispatch:** Unbounded (each channel is one socket).

---

## Backward Compatibility

✓ **Fully backward compatible.** Existing code without `channel` option works unchanged:

```javascript
// Old code (still works)
dispatch([
  thread("Task A", { agent: "scout" }),
  thread("Task B", { agent: "scout" }),
])

// New code (with channels)
dispatch([
  thread("Task A", { agent: "scout", channel: "collab" }),
  thread("Task B", { agent: "scout", channel: "collab" }),
])
```

---

## Future Extensions

### R3a: Orchestrator Channel Monitoring

```typescript
// In orchestrator
const handle = createChannelGroup(...)
const channel = handle.group.channel("collab")

channel.on("message", (msg, clientId) => {
  console.log(`[${clientId}] ${msg.msg}`)
})

await dispatchThreads(threads, { channelGroup: handle })
```

### R3b: Barrier Primitive

```javascript
// Inside thread
await barrier("collab")  // Wait for all peers to reach this point
```

Requires bidirectional signalling (thread → orchestrator → all threads).

### R3c: TCP Bridges for Distributed Dispatch

Leverage agent-channels' `TcpBridgeServer` / `TcpBridgeClient` to enable channels across machines.

---

## References

- **Agent-Channels package:** `~/.pi/packages/pi-channels/packages/agent-channels/`
- **Spindle Roadmap:** `scratchpad/plans/2026-03-15-spindle-extension.md` (item R3)
- **Design doc:** `CHANNEL_DESIGN.md`
