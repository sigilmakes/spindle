---
name: script-plan
description: >
  Create executable .spindle.js plans for the Spindle REPL. Use when planning multi-step
  work that involves sub-agents, parallel tasks, or phased execution. Produces a
  .spindle.js script (the executable plan) and a companion .md file (design context
  and rationale).
argument-hint: [topic or feature to plan]
---

# Script Plan

> **Prerequisites:** Read `repl` skill for REPL basics, `./references/plan-patterns.md` for common plan shapes.

Create an executable plan for: **$ARGUMENTS**

## What This Produces

Two files, colocated wherever makes sense for your project:

```
<name>.md     ← Design context: problem, rationale, decisions, constraints
<name>.spindle.js  ← Executable plan: discovery, orchestration, verification
```

The `.md` captures *why*. The `.spindle.js` captures *what*. The script references the markdown. A future instance reads the `.md` to understand, runs the `.spindle.js` to execute.

## Writing the Markdown

The companion `.md` is for context that doesn't belong in code:

- **Problem statement** — what's wrong and why it matters
- **Design decisions** — what you chose and what you rejected
- **Constraints** — what can't change, external dependencies
- **Verification criteria** — how to know the work is done

Keep it concise. This isn't a spec — it's orientation for the executing agent.

## Writing the Script

### Structure

Every script follows the same shape:

```javascript
// plan: <name>
// See <name>.md for design rationale

// === Context ===
// Terse summary for sub-agent prompts
CONTEXT = `...`

// === Phase 1: Foundation (sequential) ===
ep = await llm(`${CONTEXT}\n\n<specific task>`, { name: "phase-1-label" })
if (ep.status !== "success") { console.log("Phase 1 failed:", ep.summary); return }
await bash({ command: "npm test" })

// === Phase 2: Parallel work ===
targets = (await ls({ path: "src/" })).output.split("\n").filter(...)
tasks = targets.map(t => thread(`${CONTEXT}\n\nUpdate ${t}: ...`, { name: t }))
results = await dispatch(tasks)

// === Phase 3: Verify ===
await bash({ command: "npm test" })

// === Report ===
console.log("Done.")
results.forEach(ep => console.log(`${ep.name}: ${ep.status}`))
```

### String Quoting

Prompts inside scripts are JavaScript strings containing prose — backticks, quotes, Nix syntax, markdown. This is fragile. Rules:

**Don't nest backticks.** Template literals can't contain unescaped backticks. This is the #1 cause of broken scripts.

```javascript
// ✗ BROKEN — backticks inside backticks
ep = await llm(`Fix the \`deprecated\` option`, { name: "fix" })

// ✓ String concatenation for prompts with special characters
ep = await llm("Fix the `deprecated` option in " + filePath, { name: "fix" })

// ✓ Template literals are fine when content is clean
ep = await llm(`Analyze ${dir}/ and summarize`, { name: dir })
```

**Run the linter before execution:**

```bash
node bin/lint-plan.mjs <path-to-plan.spindle.js>
```

The linter catches syntax errors, nested backticks, oversized prompts, missing names, missing error gates, and missing verification steps.

### Rules

**Discover, don't hardcode.** File lists come from `ls()`, `find()`, `grep()` — not hand-typed arrays. The plan adapts to the codebase as it is when it runs, not as it was when you wrote the plan.

**Gate phases on success.** If a foundation phase fails, don't proceed. Check `ep.status` and bail with a clear message.

**Verify after each phase.** Run the test suite (or a targeted subset) between phases. Catch breakage early.

**Keep CONTEXT terse.** Sub-agents can read files themselves. CONTEXT is orientation, not a full spec — what changed, what the goal is, what to watch out for.

**Name everything.** `{ name: "..." }` on every `llm()` and `thread()` call. Names flow through to episode data and make reports readable.

### Resumption

Scripts should be resumable after partial failure. Two approaches:

**Idempotent phases** (preferred): Each phase checks if its work is already done before running.

```javascript
// Phase 1: only run if scheme.py still exists
exists = await bash({ command: "test -f src/core/scheme.py && echo yes || echo no" })
if (exists.output.trim() === "yes") {
    ep = await llm("Merge SchemeInfo into Compressor...", { name: "merge" })
    if (ep.status !== "success") return
}

// Phase 2: runs regardless — sub-agents check file state themselves
```

**Section commenting** (fallback): Comment out completed phases and re-run. Less elegant but always works.

### What Doesn't Belong in a Script

- **Exploratory work.** If you don't know the codebase well enough to write phases, use the REPL interactively first. Scripts are for plans you can specify.
- **One-shot tasks.** A single `llm()` call doesn't need a script. Just run it.
- **Ambiguous decisions.** If a phase requires human judgment, end the script there and surface the decision. Don't automate past uncertainty.

## Estimation

| Script complexity | Phases | Typical cost |
|---|---|---|
| Simple (sequential, 2-3 tasks) | 1-2 | $0.10-0.50 |
| Medium (sequential + parallel wave) | 2-3 | $0.50-2.00 |
| Large (multi-wave, many agents) | 3-5 | $2.00-10.00 |

Estimate based on sub-agent count × task complexity. A dispatch of 5 scouts is ~$1. A dispatch of 5 workers making edits is ~$2-5.
