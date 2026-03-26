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

    // === Inner loop: implement/review ===
    for (let attempt = 0; attempt < maxReviewAttempts; attempt++) {
        // Implement
        impl = await llm(`You are working in ${process.cwd()}.

Task: ${task.description}
${feedback ? `\nPrevious review feedback — address these issues:\n${feedback}` : ""}
${progress ? `\nWork completed so far in this plan:\n${progress}` : ""}

Implement this task. Run relevant tests to verify your changes work.
Commit when done.`, {
            name: `impl-${task.id}-${attempt}`
        })

        if (impl.status !== "success") {
            console.log(`❌ Implementation failed: ${impl.summary}`)
            await bash({ command: "git checkout -- ." })
            break
        }

        // Review
        review = await llm(`Review the most recent git changes for this task: "${task.description}"

Run \`git diff HEAD~1\` to see the changes. Also run tests.

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
            console.log(`✅ Approved: ${task}`)
            break
        }

        // Review rejected — prepare feedback for next attempt
        feedback = review.findings.join("\n")
        console.log(`🔄 Review rejected (attempt ${attempt + 1}/${maxReviewAttempts})`)
        console.log(`   Feedback: ${feedback.slice(0, 200)}`)

        // Revert the failed implementation
        await bash({ command: "git revert HEAD --no-edit 2>/dev/null || git checkout -- ." })
    }

    if (approved) {
        progress += `\n- ${task.description}: ${impl.summary}`
        task.done = true
        await save(".pi/work-tasks.json", JSON.stringify(tasks, null, 2))
    } else {
        console.log(`❌ Failed after ${maxReviewAttempts} attempts: ${task.description}`)
        console.log(`Last feedback:\n${feedback}`)
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

When the reviewer rejects, the implementation must be reverted before the next attempt. Two approaches:

- `git revert HEAD --no-edit` — clean revert commit, preserves history
- `git checkout -- .` — discard changes, no history

The template tries `revert` first (preserves the record of what was tried), falls back to `checkout` if revert fails (e.g. implementer didn't commit, or made multiple commits).

For more complex revert needs, use `git log --oneline -5` to find the right commit to reset to.

## Cost

Each task costs roughly: (implementation cost × attempts) + (review cost × attempts). At ~3 attempts max:

- Simple task: ~$0.10-0.30
- Medium task: ~$0.30-1.00
- Complex task: ~$1.00-3.00

A 10-task plan might cost $3-15 total.

## Gotchas

- **Reviewer and implementer need different prompts.** Same prompt reviewing its own work has approval bias.
- **The implementer gets the reviewer's feedback verbatim.** If the feedback is vague ("needs improvement"), the next attempt will be random. The review prompt must demand specifics.
- **Revert assumes one commit per implementation.** If the implementer makes multiple commits, you need `git reset --hard HEAD~N` instead. Consider adding "make exactly one commit" to the implementation prompt.
- **Progress string can mislead.** If a task was implemented, reverted, and re-implemented, the progress only shows the final version. Previous attempts are in git history.
