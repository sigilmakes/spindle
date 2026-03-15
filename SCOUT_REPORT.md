# Scout Report: Spindle R3 Channel Integration

**Date:** 2026-03-15  
**Task:** Design Unix domain socket channel integration for thread dispatch  
**Status:** ✓ Complete — Ready for implementation  

---

## Mission Summary

Designed minimal viable implementation (MVI) for Spindle's R3 roadmap item: **Channel-Based Message Passing Between Threads**. This enables real-time inter-thread messaging during parallel `dispatch()` operations, supporting collaborative multi-agent work.

---

## Key Findings

### 1. Agent-Channels Foundation Is Solid

✓ **Exists:** `~/.pi/packages/pi-channels/packages/agent-channels/` (v0.1.0)
✓ **Self-contained:** No external dependencies, works as-is
✓ **Clean API:** `ChannelGroup`, `Channel`, `ChannelClient`, `Message`
✓ **Proven:** Already used by pi-swarm for agent coordination
✓ **Extensible:** Includes TCP bridges for future distributed use

**Core pattern:**
- Server: `Channel` (Unix domain socket) fans out messages to all connected clients
- Client: `ChannelClient` connects and sends/receives
- Framing: Length-prefixed JSON (4-byte BE uint32 + UTF-8)
- Group: `ChannelGroup` manages a directory of named channels with lifecycle

**Perfect for Spindle because:**
- No subprocess overhead (pure Node.js IPC)
- Fan-out is exactly what we need (all threads on a channel see messages)
- Automatic cleanup support
- Socket files on disk (filesystem-based addressing)

### 2. Integration Point: Thread Options + Environment Variables

**Design decision:** Inject via environment variables, detected at REPL startup.

```javascript
// User writes this:
await dispatch([
  thread("Implement API", { agent: "worker", channel: "collab" }),
  thread("Implement tests", { agent: "worker", channel: "collab" }),
])

// Orchestrator does this:
// - createChannelGroup(["collab"]) → /tmp/spindle-channels-12345-1710520123/
// - For each thread: set SPINDLE_CHANNELS={...socket paths...}, SPINDLE_THREAD_ID=worker-1
// - Sub-agent REPL detects env vars, injects send() and recv()

// Thread code:
await send("collab", "Updated user schema")
const msg = await recv("collab")  // blocks until message arrives
```

**Why environment variables?**
- ✓ No command-line arg escaping headaches
- ✓ Transparent to sub-agent startup
- ✓ REPL can auto-detect and inject without user code
- ✓ Clean separation: orchestrator sets env, REPL consumes it

### 3. Minimal Viable Implementation (MVI)

**Size: ~325–425 new LOC across 5 files**

| File | Changes | LOC | Purpose |
|------|---------|-----|---------|
| `channels-integration.ts` | NEW | 60–80 | Channel group lifecycle (create, cleanup) |
| `threads.ts` | MODIFY | +15 | Add `channel` option to `ThreadOptions` |
| `agents.ts` | MODIFY | +40–50 | Inject `SPINDLE_CHANNELS` env var |
| `repl.ts` | MODIFY | +80–100 | Detect env vars, lazy connect, inject send/recv |
| `index.ts` | MODIFY | +30–50 | Create group before dispatch, cleanup after |
| Tests | NEW | 100–150 | Unit + integration tests |

**Core functions (4 total):**
1. `createChannelGroup(names)` → `ChannelGroupHandle` — create sockets
2. `send(channelName, msg, data?)` — injected into thread REPL
3. `recv(channelName)` → string — blocks until message arrives
4. Cleanup logic in dispatch teardown

**API surface (from user perspective):**
```javascript
// Option 1: Single channel
thread("task", { channel: "collab" })

// Option 2: Multiple channels
thread("task", { channel: ["api", "shared"] })

// Option 3: No channels (existing behavior)
thread("task", { agent: "scout" })
```

### 4. Decision Points & Tradeoffs

| Decision | Rationale | Alternative |
|----------|-----------|-------------|
| Thread-local groups (per dispatch) | Isolates concurrent dispatches, auto cleanup | Global server (rejected: complex lifecycle) |
| Lazy client connect | Faster REPL startup | Eager connect (rejected: connection errors upfront) |
| recv() blocking (no timeout default) | Matches Unix IPC semantics | Configurable timeout (future: `recvTimeout()`) |
| Throw on errors | Explicit handling, thread captures failure | Silent failures (rejected: loses visibility) |
| Socket paths via env vars | Clean, auto-injectable | CLI args (rejected: escaping issues) |

### 5. Risk Mitigation ✓

| Risk | Mitigation |
|------|-----------|
| Socket path conflicts | tmpdir + pid + timestamp; stale socket detection |
| Orphaned sockets on crash | Stale socket detection on next start; cleanup on dispatch end |
| Hanging recv() | Thread timeout catches it, episode captures failure |
| Message loss if late connect | ChannelGroup queues messages until first client arrives |
| Large messages | 16 MB limit enforced by FrameDecoder |

### 6. Backward Compatibility ✓

**100% backward compatible.** Existing code without `channel` option works unchanged. No ChannelGroup created, no env vars injected, no behavior change.

---

## Deliverables

### 1. Design Document: `CHANNEL_DESIGN.md`
- 37 KB, comprehensive specification
- Covers: foundation, architecture, MVI implementation, decisions, risks, roadmap
- Implementation checklist for developers
- 5 code samples showing integration points

### 2. Architecture Diagram: `CHANNELS_ARCHITECTURE.md`
- 28 KB, visual reference
- High-level data flow
- Detailed socket architecture
- Sequence diagrams (scenario: two workers collaborating)
- File change checklist
- Testing strategy + error scenarios

### 3. Scout Report: This document
- Executive findings
- Decision rationale
- MVI summary
- Path to implementation

---

## What's Ready to Build

### Phase 3a: Basic Channel Injection (1 file, ~150 LOC)
**File:** `channels-integration.ts` — Lifecycle management
```typescript
export async function createChannelGroup(names: string[]): Promise<ChannelGroupHandle>
```
- Create temp directory
- Start ChannelGroup with named channels
- Return handle with socket paths
- Provide cleanup function

**Status:** Ready to code — no blockers

### Phase 3b: Update ThreadOptions (2 files, ~100 LOC)
**Files:** `threads.ts`, `index.ts` — Option plumbing
```typescript
channel?: string | string[]  // Add to ThreadOptions
```
- Extract channel names from all threads
- Create group if any thread uses channels
- Pass to dispatchThreads
- Cleanup after dispatch

**Status:** Ready to code — straightforward edits

### Phase 3c: Sub-Agent Channel Integration (1 file, ~200 LOC)
**File:** `agents.ts` → `repl.ts` — Socket connect + APIs
- Inject `SPINDLE_CHANNELS` and `SPINDLE_THREAD_ID` env vars
- Detect in REPL, lazy-connect `ChannelClient` instances
- Inject `send()` and `recv()` functions
- Cleanup on REPL shutdown

**Status:** Ready to code — all APIs documented in agent-channels README

---

## Dependencies

### Required
- ✓ `agent-channels` v0.1.0+ already available at `~/.pi/packages/pi-channels/packages/agent-channels/`
- ✓ Node.js 20+ (required by agent-channels)

### No New External Dependencies

---

## Testing Strategy

### Unit (3 tests, ~50 LOC)
1. Channel group creation & cleanup
2. Environment variable injection
3. REPL channel detection

### Integration (3 tests, ~100 LOC)
1. Two threads on one channel (send/recv)
2. Three threads on multiple channels
3. No channels (backward compat)

**Verification approach:**
- Create threads that send/recv messages
- Verify both threads complete successfully
- Check episode status and findings
- Verify sockets cleaned up

---

## Future Extensions (Post-MVI)

### R3a: Orchestrator Channel Monitoring
```typescript
channel.on("message", (msg, clientId) => { ... })
```

### R3b: Barrier Primitive
```javascript
await barrier("collab")  // Wait for all peers
```
Requires bidirectional signalling (defer to R1: Stepped Threads).

### R3c: TCP Bridges for Distributed Dispatch
Leverage agent-channels' `TcpBridgeServer`/`TcpBridgeClient`.

---

## Implementation Path

### Session 1: Foundations (1–1.5 hours)
- [ ] Create `channels-integration.ts` (lifecycle)
- [ ] Update `threads.ts` + `index.ts` (option plumbing)
- [ ] Unit tests for group creation

### Session 2: Integration (1.5–2 hours)
- [ ] Update `agents.ts` (env var injection)
- [ ] Update `repl.ts` (client connect, send/recv injection)
- [ ] Integration tests (send/recv flow)
- [ ] Backward compat test

### Session 3: Polish (0.5–1 hour)
- [ ] Error handling edge cases
- [ ] Documentation + README update
- [ ] Verify spindle_exec dispatch with channels

**Total effort:** 3–4.5 hours (3–4 coffee runs)

---

## Open Questions for Implementation

1. **Thread ID format?** Currently: `${agent}-${index}`. Alternative: UUID. Proposal: UUID (less predictable, better for distributed future).

2. **Message data format conventions?** Currently: `{ msg, data: { from: threadId, ...custom } }`. Should we standardize `data` fields? Proposal: User-defined via `data` param.

3. **Max message count per channel?** Default: 1000 queued messages. Is this reasonable? Proposal: Keep default, document in roadmap for future tuning.

4. **Logging/observability?** Should we log when threads connect/disconnect? Proposal: Optional via `SPINDLE_CHANNEL_DEBUG` env var (defer to polish phase).

5. **Testing real-world scenario?** Suggest: audit workflow with two scouts on shared "research" channel, comparing findings in real-time.

---

## Related Documentation

- **Agent-Channels README:** `~/.pi/packages/pi-channels/packages/agent-channels/README.md` ✓ (reviewed)
- **Spindle Roadmap R3:** `scratchpad/plans/2026-03-15-spindle-extension.md` ✓ (reviewed)
- **Spindle Design:** `CHANNEL_DESIGN.md` ✓ (created)
- **Architecture Diagrams:** `CHANNELS_ARCHITECTURE.md` ✓ (created)

---

## Confidence Level

**95% confident** in this design. Why?

✓ Agent-channels is production-ready and proven  
✓ Environment variable injection is simple and robust  
✓ Unix domain sockets are well-understood IPC  
✓ Scope is small (MVI = ~400 LOC)  
✓ All integration points are in existing Spindle code  
✓ Backward compatible (no breaking changes)  
✓ Error paths are clear and handled by existing episode system  

**Minor uncertainty:**
- Exact threading/message ordering semantics (shouldn't matter for MVI — keep simple)
- Performance at scale (>100 concurrent threads) — acceptable risk for V1

---

## Recommendation

**Proceed with implementation.** The design is complete, risks are mitigated, and the implementation path is clear. This is a straightforward addition to Spindle that unblocks collaborative multi-agent patterns.

For development:
1. Start with Session 1 (foundations)
2. Follow checklist in `CHANNEL_DESIGN.md`
3. Reference `CHANNELS_ARCHITECTURE.md` for visual guidance
4. Treat agent-channels README as authoritative API docs

