# Ralph-Critic Loop

Iterate sub-agents over a task list with a review cycle per task. Each task gets implemented, reviewed, and iterated until the reviewer approves. The default pattern for most plans.

## When To Use

- Implementation work where quality matters
- Plans where you'd normally want code review at each step
- Any task list that isn't purely mechanical

## Template

```javascript
// === Setup ===
tasks = JSON.parse(await load(".pi/work-tasks.json"))
progress = ""
maxReviewAttempts = 3

remaining = tasks.filter(t => !t.done)
console.log(`Found ${remaining.length} tasks remaining`)

// === Outer loop: tasks ===
for (const task of tasks) {
    if (task.done) continue
    console.log(`\n--- Task ${task.id}: ${task.description} ---`)
    let feedback = ""
    let approved = false

    // Save checkpoint — reset to this on any revert
    checkpoint = (await bash({ command: "git rev-parse HEAD" })).output.trim()

    // === Inner loop: implement/review ===
    for (let attempt = 0; attempt < maxReviewAttempts; attempt++) {
        // Implement
        impl = await subagent(`You are working in ${process.cwd()}.

Task: ${task.description}
${feedback ? `\nPrevious review feedback — address these issues:\n${feedback}` : ""}
${progress ? `\nWork completed so far in this plan:\n${progress}` : ""}

Implement this task. Run relevant tests to verify your changes work.
Make exactly one commit when done.`, {
            name: `impl-${task.id}-${attempt}`
        }).result

        if (!impl.ok) {
            console.log(`❌ Implementation failed`)
            await bash({ command: `git reset --hard ${checkpoint}` })
            break
        }

        // Review
        review = await subagent(`Review the most recent git changes for this task: "${task.description}"

Run \`git diff ${checkpoint}\` to see the changes. Also run tests.

Evaluate:
- Correctness: does it do what the task asks?
- Edge cases: are error conditions handled?
- Code quality: is it clean, well-named, idiomatic?
- Tests: are changes tested?

If you would merge this as-is, say APPROVED.
If changes are needed, say REJECTED and list specific, actionable issues.
Do not rubber-stamp. Be rigorous.`, {
            name: `review-${task.id}-${attempt}`
        }).result

        if (review.text.includes("APPROVED")) {
            approved = true
            console.log(`✅ Approved: ${task.description}`)
            break
        }

        // Review rejected
        feedback = review.text
        console.log(`🔄 Review rejected (attempt ${attempt + 1}/${maxReviewAttempts})`)

        // Reset to checkpoint
        await bash({ command: `git reset --hard ${checkpoint}` })
    }

    if (approved) {
        progress += `\n- ${task.description}: done`
        task.done = true
        await save(".pi/work-tasks.json", JSON.stringify(tasks, null, 2))
    } else {
        console.log(`❌ Failed after ${maxReviewAttempts} attempts: ${task.description}`)
        await bash({ command: `git reset --hard ${checkpoint}` })
        console.log("Stopping — review loop exhausted. Intervene and restart.")
        break
    }
}

// === Report ===
tasks = JSON.parse(await load(".pi/work-tasks.json"))
done = tasks.filter(t => t.done).length
remaining = tasks.filter(t => !t.done).length
console.log(`\nComplete: ${done} done, ${remaining} remaining`)
```

## Prompt Discipline

The reviewer prompt is critical. Key lines:

- **"If you would merge this as-is, say APPROVED."** — Forces a real judgment, not a rubber stamp.
- **"If changes are needed, say REJECTED and list specific, actionable issues."** — Ensures feedback is useful.
- **"Do not rubber-stamp. Be rigorous."** — Explicit instruction against approval bias.

## Revert Strategy

The template saves a git ref (`checkpoint`) before each task and uses `git reset --hard` to revert. Robust regardless of commit count.

## Parallelism

The review cycle makes parallelism harder because each task's implement/review loop is stateful. Use `subagent()` with worktrees only for truly independent tasks. Sequential is the right default for this pattern.

## Gotchas

- **Reviewer and implementer need different prompts.** Same prompt reviewing its own work has approval bias.
- **Progress string can mislead.** If a task was reverted and re-implemented, progress only shows the final version.
- **The progress string grows.** For long task lists, truncate to the last 10 entries.
