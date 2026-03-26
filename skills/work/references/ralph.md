# Ralph Loop

Iterate sub-agents over a task list. One fresh agent per task, commit each, persist progress. No review cycle — just get it done.

## When To Use

- Mechanical tasks where correctness is straightforward (migrations, renames, formatting)
- Large task lists where review per task would be too expensive
- Tasks where the test suite is the quality gate

## Template

```javascript
// === Setup ===
tasks = JSON.parse(await load(".pi/work-tasks.json"))
progress = ""

remaining = tasks.filter(t => !t.done)
console.log(`Found ${remaining.length} tasks remaining`)

// === Loop ===
for (const task of tasks) {
    if (task.done) continue
    console.log(`\n--- Task ${task.id}: ${task.description} ---`)

    // Save checkpoint for clean revert
    checkpoint = (await bash({ command: "git rev-parse HEAD" })).stdout.trim()

    ep = await llm(`You are working in ${process.cwd()}.

Task: ${task.description}

Previous progress:
${progress}

Implement this task. Run relevant tests. Commit when done.`, {
        name: `task-${task.id}`,
    })

    if (ep.status === "success") {
        progress += `\n- ${task.description}: ${ep.summary}`
        task.done = true
        await save(".pi/work-tasks.json", JSON.stringify(tasks, null, 2))
        await bash({ command: `git add -A && git diff --cached --quiet || git commit -m "feat: ${task.description.slice(0, 50)}"` })
        console.log(`✅ Done: ${task.description}`)
    } else {
        console.log(`❌ Failed: ${task.description}`)
        console.log(`   ${ep.summary}`)
        progress += `\n- ${task.description}: FAILED — ${ep.summary}`
        await bash({ command: `git reset --hard ${checkpoint}` })
        console.log("Stopping — task failed. Review and restart.")
        break
    }
}

// === Report ===
tasks = JSON.parse(await load(".pi/work-tasks.json"))
done = tasks.filter(t => t.done).length
remaining = tasks.filter(t => !t.done).length
console.log(`\nComplete: ${done} done, ${remaining} remaining`)
```

## Progress State

Progress accumulates as a string and gets fed to each sub-agent so it knows what's already been done. This avoids re-reading the whole plan each iteration while keeping context light.

The task file is the source of truth for what's done — it survives crashes.

## Parallelism

The loop above is sequential. For truly independent tasks — different files, no shared state — you can `dispatch()` them in parallel:

```javascript
// Only for tasks that are completely file-disjoint
independent = tasks.filter(t => !t.done && t.parallel)
specs = independent.map(t => thread(`Task: ${t.description}`, { name: `task-${t.id}` }))
results = await dispatch(specs)
```

**Be very cautious with this.** Naive parallelism causes real problems:

- **Git state is shared.** Parallel agents committing to the same branch will clash.
- **File conflicts.** Two agents editing the same file — or files that import each other — will silently clobber each other's work.
- **Progress context breaks.** Parallel agents can't see each other's changes, so the rolling progress string becomes meaningless.
- **Test interference.** Parallel test runs may share databases, ports, or temp files.

If you want parallel execution, consider **git worktrees** — each agent gets its own working directory on a separate branch, then you merge. But that's significantly more orchestration. Default to sequential unless you've verified the tasks are truly isolated.

## Gotchas

- **Task descriptions must be specific.** "Refactor the auth module" is too vague for an unsupervised agent. "Extract the JWT validation from auth.ts into a separate jwt.ts module" works. If tasks keep failing, the descriptions are probably too vague — split or rewrite them.
- **Git state must be clean before starting.** Uncommitted changes will get mixed into the first commit.
- **The progress string grows.** For very long task lists (20+), consider truncating to the last 10 entries.
