---
name: script-cycle
description: >
  Execute one cycle of a .spindle.js plan via Spindle REPL. Handles orientation,
  execution, error recovery, and reporting. Use when a .spindle.js plan exists
  and you want to run it or resume from a partial execution.
argument-hint: <path-to-plan.spindle.js> [--dry-run] [--from <phase>]
---

# Script Cycle

> **Related skills:** `repl` for REPL basics, `script-plan` for writing plans.

Execute a cycle on: **$ARGUMENTS**

## Overview

A script cycle runs a `.spindle.js` plan. The cycle:

1. **Orient** — Read the companion `.md`, check git state, understand where we are
2. **Execute** — Run the script via `spindle_exec({ file: ... })`
3. **Handle failures** — If phases fail, diagnose and decide: fix, retry, or stop
4. **Report** — Summarize results

After execution, present results and stop. The user decides what happens next.

## Phase 1: Orient

### Lint the script

Before anything else, run the linter:

```bash
node bin/lint-plan.mjs <path-to-plan.spindle.js>
```

Fix any errors before proceeding. Warnings are advisory but worth reviewing — missing error gates and unnamed agents cause pain later.

### Read the plan pair

Every script plan has a companion `.md`. Read both:

```javascript
// The .md tells you WHY
plan = await load("<name>.md")

// The .spindle.js tells you WHAT
script = await load("<name>.spindle.js")
```

Understand the goal, the phases, and what success looks like before running anything.

### Check current state

```javascript
// What branch are we on? Any uncommitted changes?
await bash({ command: "git status --short" })
await bash({ command: "git log --oneline -5" })

// Do tests pass before we start?
await bash({ command: "npm test" })
```

If the codebase isn't clean, resolve that first. Don't run a plan on top of a broken state.

### Check for prior execution

If this script was partially run before, check what's already done:

- Check git log for commits related to this plan
- Look for any prior reports or notes about this plan
- Look at the script's idempotency guards (if it has them)

If `--from <phase>` was specified, note which phase to start from.

### Present to user

Before executing, summarize:
- What the plan does (from the `.md`)
- How many phases and sub-agents it involves (from the `.spindle.js`)
- Current codebase state
- Whether this is a fresh run or a resumption

Get approval before proceeding.

## Phase 2: Execute

### Fresh run

```javascript
await spindle_exec({ file: "<path-to-plan.spindle.js>" })
```

The script runs in the REPL context. Its `console.log` output appears in the tool result. Episode data from `dispatch()` and `llm()` calls is captured automatically.

### Resuming from a phase

If resuming, edit the script to skip completed phases before running. Two approaches:

**If the script has idempotency guards:** Just re-run it. Completed phases will detect their work is done and skip.

**If not:** Comment out completed phases in a copy, or use `--from` to communicate which phase to start from. Read the script, identify the phase boundary, and adjust.

### Dry run

If `--dry-run` was specified, don't execute. Instead, read the script and report:
- Number of phases and their descriptions
- Expected sub-agent count and parallelism
- Estimated cost based on the plan's complexity
- Any issues (hardcoded paths, missing idempotency guards)

## Phase 3: Handle Failures

When a script phase fails, don't retry blindly. Diagnose first.

### Read the episode

The failed `llm()` or `dispatch()` call produced an episode. Check:
- `ep.summary` — what went wrong
- `ep.output` — the agent's full response
- `ep.findings` — any partial results
- `ep.blockers` — what stopped progress

### Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Agent edited wrong file | Ambiguous prompt | Tighten the prompt, add file paths |
| Tests fail after phase | Phase made incorrect changes | Revert (`git checkout`), fix the phase prompt |
| Agent couldn't find files | Codebase changed since plan was written | Re-run discovery, update the script |
| Timeout | Task too large for one agent | Split the phase into smaller tasks |
| File collision warning | Parallel agents wrote same file | Add barriers or split the work differently |

### Decision point

After diagnosing, choose:
1. **Fix and retry** — Edit the script, re-run the failed phase
2. **Skip and continue** — If the failure is non-critical, move on
3. **Stop and report** — If the plan needs redesign, stop here

Surface this decision to the user. Don't auto-retry past the first failure.

## Phase 4: Report

After execution (successful or not), write a report.

### Auto-generate from episodes

If the script stored results in variables, aggregate them:

```javascript
// Collect all episodes from the execution
allEpisodes = results || [ep]  // dispatch results or single llm result
report = `# Cycle Report: <name>\n\n`
report += `**Date**: ${new Date().toISOString().slice(0, 10)}\n`
report += `**Status**: ${allEpisodes.every(e => e.status === "success") ? "Complete" : "Partial"}\n\n`
report += `## Results\n\n`
allEpisodes.forEach(ep => {
    report += `### ${ep.name || "unnamed"} (${ep.status})\n`
    report += ep.summary + "\n\n"
    if (ep.findings.length) report += ep.findings.map(f => `- ${f}`).join("\n") + "\n\n"
})
report += `## Cost\n\nTotal: $${allEpisodes.reduce((s, e) => s + e.cost, 0).toFixed(2)}\n`
await save("<report-path>.md", report)
```

### Present results

Show the user: what succeeded, what failed, total cost, and what's next (another cycle, manual review, plan revision).
