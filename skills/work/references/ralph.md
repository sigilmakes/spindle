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
        await bash({ command: `git add -A && git commit -m "feat: ${task.description.slice(0, 50)}"` })
        console.log(`✅ Done: ${task.description}`)
    } else {
        console.log(`❌ Failed: ${task.description}`)
        console.log(`   ${ep.summary}`)
        progress += `\n- ${task.description}: FAILED — ${ep.summary}`
        await bash({ command: "git checkout -- ." })
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

The plan file itself is the source of truth for what's done — checked boxes survive crashes.

## Gotchas

- **Task descriptions must be specific.** "Refactor the auth module" is too vague for an unsupervised agent. "Extract the JWT validation from auth.ts into a separate jwt.ts module" works.
- **Git state must be clean before starting.** Uncommitted changes will get mixed into the first commit.
- **The progress string grows.** For very long task lists (20+), consider truncating to the last 10 entries.
- **Task descriptions must be specific enough for the default model to execute.** If tasks keep failing, the descriptions are too vague — split or rewrite them.
