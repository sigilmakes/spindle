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
    checkpoint = (await bash({ command: "git rev-parse HEAD" })).output.trim()

    ep = await llm(`You are working in ${process.cwd()}.

Task: ${task.description}

Previous progress:
${progress}

Implement this task. Run relevant tests. Commit when done.`, {
        name: `task-${task.id}`,
    })

    if (ep.ok) {
        progress += `\n- ${task.description}: ${ep.text.slice(0, 200)}`
        task.done = true
        await save(".pi/work-tasks.json", JSON.stringify(tasks, null, 2))
        await bash({ command: `git add -A && git diff --cached --quiet || git commit -m "feat: ${task.description.slice(0, 50)}"` })
        console.log(`✅ Done: ${task.description}`)
    } else {
        console.log(`❌ Failed: ${task.description}`)
        progress += `\n- ${task.description}: FAILED`
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

For independent tasks — different files, no shared state — use `spawn()` to run them in parallel on separate worktrees:

```javascript
independent = tasks.filter(t => !t.done && t.parallel)
workers = independent.map(t => spawn(`Task: ${t.description}`, { name: `task-${t.id}` }))
results = await Promise.all(workers.map(w => w.result))

// Merge successful ones
for (let i = 0; i < workers.length; i++) {
    if (results[i].status === "success") {
        await bash({ command: `git merge ${workers[i].branch}` })
        independent[i].done = true
    }
}
await save(".pi/work-tasks.json", JSON.stringify(tasks, null, 2))
```

Each worker gets its own git worktree — no file conflicts, no git clashes.

## Gotchas

- **Task descriptions must be specific.** "Refactor the auth module" is too vague for an unsupervised agent. "Extract the JWT validation from auth.ts into a separate jwt.ts module" works. If tasks keep failing, the descriptions are probably too vague — split or rewrite them.
- **Git state must be clean before starting.** Uncommitted changes will get mixed into the first commit.
- **The progress string grows.** For very long task lists (20+), consider truncating to the last 10 entries.
