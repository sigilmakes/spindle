---
name: work
description: >
  Execute a plan autonomously using sub-agent loops in spindle. Takes a plan
  (markdown task list, kanban board, or scratchpad plan), parses it into tasks,
  and loops sub-agents over them with review cycles and git-backed state.
  Use when asked to "work through this plan", "ralph over this", "autopilot",
  "execute this plan autonomously", or "loop over these tasks".
argument-hint: <path-to-plan> [--pattern ralph|ralph-critic|implementer-critic|research]
---

# /work — Autonomous Plan Execution

Execute: **$ARGUMENTS**

> **Pattern references — read the relevant one before starting:**
> - **`./references/ralph.md`** — iterate tasks, one agent per task, commit each
> - **`./references/ralph-critic.md`** — same but with review loop per task
> - **`./references/implementer-critic.md`** — single goal with implement/review cycles
> - **`./references/research.md`** — optimize a metric with keep/revert

## Flow

1. **Read the plan** — load the file, understand the tasks and goals
2. **Pick a pattern** — match the work to a pattern, or use what the user asked for
3. **Prepare** — for task-list patterns (ralph, ralph-critic): parse tasks into a structured list. For single-goal patterns (implementer-critic): extract the goal. For research: identify the metric and benchmark command.
4. **Run the loop** — execute in spindle per the pattern
5. **Report** — summarize what was done, what's left

## Picking a Pattern

| Situation | Pattern | Reference |
|-----------|---------|-----------|
| List of tasks to implement | ralph | `./references/ralph.md` |
| List of tasks, each needs quality review | ralph-critic | `./references/ralph-critic.md` |
| Single goal, iterate until good | implementer-critic | `./references/implementer-critic.md` |
| Optimizing a measurable metric | research | `./references/research.md` |

**How to choose:**

- If the user specifies a pattern, use it.
- If the work is **optimizing a measurable metric** (performance, accuracy, bundle size, latency), use **research**. The key signal: there's a benchmark command and a number to improve.
- If the work is a **single goal** that needs iteration ("build this feature", "fix this bug properly"), use **implementer-critic**.
- If the work is a **list of tasks**, use **ralph** (mechanical/fast) or **ralph-critic** (quality matters). Default to ralph-critic if unsure between these two.
- If they say "ralph" they mean without review. If they say "with review" or don't specify a task-list pattern, use ralph-critic.

## Preparing Tasks (ralph, ralph-critic)

For task-list patterns, read the plan — whatever format it's in — and construct a JSON task list. Each task needs an id, a description specific enough for a sub-agent to execute, and a done flag.

```javascript
plan = await load(planFile)

// Read the plan, understand it, then build the task list.
// Don't try to regex-parse arbitrary markdown — use your judgment.
tasks = [
    { id: "1", description: "Extract JWT validation from auth.ts into jwt.ts", done: false },
    { id: "2", description: "Update all imports of validateToken to use jwt.ts", done: false },
    { id: "3", description: "Add unit tests for jwt.ts covering expired and malformed tokens", done: false },
]

// Save so state survives crashes
await save(".pi/work-tasks.json", JSON.stringify(tasks, null, 2))
```

The task list is yours to construct. Read the plan, break it down, order dependencies, make descriptions specific. This is judgment work — don't automate it.

**Task descriptions must be specific.** "Refactor auth" will fail unsupervised. "Extract JWT validation from auth.ts into a separate jwt.ts module" succeeds. If a plan item is too vague, split it into concrete steps before starting.

For resumption, save `.pi/work-tasks.json` and check it at the start of each iteration. Tasks with `done: true` get skipped.

For **implementer-critic**, there's no task list — just a goal string. For **autoresearch**, see the pattern reference for setup.

## Running

Read the relevant pattern reference, then run inline or as a script:

```javascript
// Inline for small plans
spindle_exec({ code: `
    // ... adapted from pattern reference
`})

// Script for complex plans
spindle_exec({ file: "path/to/work.spindle.js" })
```

## State & Resumption

For task-list patterns (ralph, ralph-critic):

- **`.pi/work-tasks.json` is the source of truth.** Update it as tasks complete. REPL variables die with the session; the file survives.
- **Git commit after each task.** The history is the log. Each commit is a checkpoint you can revert to.
- **To resume:** re-read `.pi/work-tasks.json`. Tasks with `done: true` get skipped. Pick up from the first incomplete one.

```javascript
// Mark a task done
task.done = true
await save(".pi/work-tasks.json", JSON.stringify(tasks, null, 2))
```

For implementer-critic, state is simpler: check git log — either the commit is there or it isn't. For autoresearch, the metric baseline and git history are the state.

## Cleanup

For task-list patterns, delete the task file when all tasks are done (or the work is abandoned):

```javascript
await bash({ command: "rm .pi/work-tasks.json" })
```

Don't leave stale task files around — a future `/work` invocation might pick them up.

## Conventions

- **Fresh sub-agent per task.** No context bloat across tasks.
- **Bail after 3 failed attempts on one task.** Surface to the user, don't burn money.
- **Run tests between tasks** when applicable. Catch breakage early.
- **Present results before continuing** if anything unexpected happens.

## Adapting Plans

Plans come from many sources — `/plan`, kanban boards, PRDs, GitHub issues, plain text lists. Before running, you need to understand the plan well enough to:

1. **Extract a task list.** Whatever the format, get an array of task descriptions.
2. **Order the tasks.** Dependencies first. If task B needs task A's output, A goes first.
3. **Make tasks specific.** "Refactor auth" won't work unsupervised. "Extract JWT validation from auth.ts into jwt.ts" will. Split vague tasks before starting.
4. **Identify verification.** What command proves a task is done? Tests, type checks, build, lint? Set this up before the loop.
5. **Choose the pattern.** Task list → ralph or ralph-critic. Single goal → implementer-critic. Metric to optimize → research.

If a plan is too vague to extract specific tasks from, it's not ready for `/work`. Explore the codebase first, then come back with a concrete task list.

## When NOT to Use

- **Exploratory work.** If you don't know what the tasks are yet, explore first.
- **Single tasks.** Just do it directly, no loop needed.
- **Tasks requiring human judgment at each step.** Use `/cycle` instead.
