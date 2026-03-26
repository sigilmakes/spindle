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
    checkpoint = (await bash({ command: "git rev-parse HEAD" })).stdout.trim()

    // === Inner loop: implement/review ===
    for (let attempt = 0; attempt < maxReviewAttempts; attempt++) {
        // Implement
        impl = await llm(`You are working in ${process.cwd()}.

Task: ${task.description}
${feedback ? `\nPrevious review feedback — address these issues:\n${feedback}` : ""}
${progress ? `\nWork completed so far in this plan:\n${progress}` : ""}

Implement this task. Run relevant tests to verify your changes work.
Make exactly one commit when done.`, {
            name: `impl-${task.id}-${attempt}`
        })

        if (impl.status !== "success") {
            console.log(`❌ Implementation failed: ${impl.summary}`)
            await bash({ command: `git reset --hard ${checkpoint}` })
            break
        }

        // Review
        review = await llm(`Review the most recent git changes for this task: "${task.description}"

Run \`git diff ${checkpoint}\` to see the changes. Also run tests.

Evaluate:
- Correctness: does it do what the task asks?
- Edge cases: are error conditions handled?
- Code quality: is it clean, well-named, idiomatic?
- Tests: are changes tested?

Set your episode status to SUCCESS only if you would merge this as-is.
Set FAILURE if changes are needed — put specific, actionable feedback in your findings.
Do not rubber-stamp. Be rigorous.`, {
            name: `review-${task.id}-${attempt}`
        })

        if (review.status === "success") {
            approved = true
            console.log(`✅ Approved: ${task.description}`)
            break
        }

        // Review rejected — prepare feedback for next attempt
        feedback = review.findings.join("\n")
        console.log(`🔄 Review rejected (attempt ${attempt + 1}/${maxReviewAttempts})`)
        console.log(`   Feedback: ${feedback.slice(0, 200)}`)

        // Reset to checkpoint — handles any number of commits cleanly
        await bash({ command: `git reset --hard ${checkpoint}` })
    }

    if (approved) {
        progress += `\n- ${task.description}: ${impl.summary}`
        task.done = true
        await save(".pi/work-tasks.json", JSON.stringify(tasks, null, 2))
    } else {
        console.log(`❌ Failed after ${maxReviewAttempts} attempts: ${task.description}`)
        console.log(`Last feedback:\n${feedback}`)
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
console.log(`\nProgress:\n${progress}`)
```

## Prompt Discipline

The reviewer prompt is critical. Key lines:

- **"Set your episode status to SUCCESS only if you would merge this as-is."** — Forces a real judgment, not a rubber stamp.
- **"Set FAILURE if changes are needed — put specific, actionable feedback in your findings."** — Ensures feedback is useful for the next implementation attempt.
- **"Do not rubber-stamp. Be rigorous."** — Explicit instruction against approval bias.

Without these, reviewers approve nearly everything and the loop degenerates into a ralph loop with extra cost.

## Revert Strategy

The template saves a git ref (`checkpoint`) before each task and uses `git reset --hard` to revert. This is robust regardless of how many commits the implementer makes — one, three, or zero. No need to guess at `HEAD~N` or hope `git revert` handles edge cases.

The reviewer also diffs against the checkpoint (`git diff ${checkpoint}`) instead of `HEAD~1`, so it sees the full change regardless of commit count.

## Parallelism

The same caveats from ralph apply here, but amplified: the review cycle makes parallelism harder because each task's implement/review loop is stateful. Don't parallelize ralph-critic tasks unless they are completely file-disjoint and you're using separate worktrees or branches.

Sequential is the right default for this pattern.

## Gotchas

- **Reviewer and implementer need different prompts.** Same prompt reviewing its own work has approval bias.
- **The implementer gets the reviewer's feedback verbatim.** If the feedback is vague ("needs improvement"), the next attempt will be random. The review prompt must demand specifics.
- **Progress string can mislead.** If a task was implemented, reverted, and re-implemented, the progress only shows the final version. Previous attempts are in git history.
