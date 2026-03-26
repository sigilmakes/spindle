# Implementer-Critic Loop

No task list — one goal, iterated until the reviewer approves. Use when the work is a single coherent task that needs quality, not a list to burn through.

## When To Use

- "Build this feature"
- "Fix this bug properly"
- "Refactor this module"
- Any single task where "done" requires judgment, not a checklist

## Template

```javascript
// === Setup ===
goal = "<what to build/fix/refactor>"
maxAttempts = 5
feedback = ""

// Save checkpoint — reset to this on any revert
checkpoint = (await bash({ command: "git rev-parse HEAD" })).stdout.trim()

// === Loop ===
for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Implement
    impl = await llm(`You are working in ${process.cwd()}.

Goal: ${goal}
${feedback ? `\nPrevious review feedback — address ALL of these:\n${feedback}` : ""}

Implement this. Run tests. Make exactly one commit when done.`, {
        name: `impl-${attempt}`
    })

    if (impl.status !== "success") {
        console.log(`❌ Implementation failed: ${impl.summary}`)
        await bash({ command: `git reset --hard ${checkpoint}` })
        continue
    }

    // Review
    review = await llm(`Review the most recent git changes.

Goal was: ${goal}

Run \`git diff ${checkpoint}\` to see changes. Run tests.

Evaluate:
- Does it achieve the goal?
- Are edge cases handled?
- Is the code clean and tested?
- Any security or performance concerns?

Status SUCCESS = you would merge this. No reservations.
Status FAILURE = needs work. List every issue in findings.`, {
        name: `review-${attempt}`
    })

    if (review.status === "success") {
        console.log(`✅ Approved after ${attempt + 1} attempt(s)`)
        console.log(`Summary: ${impl.summary}`)
        break
    }

    feedback = review.findings.join("\n")
    console.log(`🔄 Rejected (${attempt + 1}/${maxAttempts}): ${feedback.slice(0, 200)}`)

    // Reset to checkpoint — handles any number of commits cleanly
    await bash({ command: `git reset --hard ${checkpoint}` })

    if (attempt === maxAttempts - 1) {
        console.log(`❌ Failed after ${maxAttempts} attempts. Last feedback:\n${feedback}`)
    }
}
```

## Differences from Ralph-Critic

- **No task list.** One goal, iterate until good.
- **No progress file.** State is just the feedback string.
- **No plan file to update.** Success = the commit exists. Failure = nothing changed.
- **Simpler resumption.** Check git log — either the commit is there or it isn't.

## Gotchas

- **The goal must be specific.** "Make the auth better" will loop forever. "Add rate limiting to the login endpoint, max 5 attempts per minute per IP" converges.
- **Feedback replaces, not accumulates.** Each rejection gives the implementer only the latest review's feedback. For a single goal this is usually fine — the reviewer sees the same diff each time. But if the implementer fixes issue A and introduces issue B, the feedback for B won't mention A. If this is a problem, accumulate: `feedback += "\n" + review.findings.join("\n")`.
- **Don't loop forever.** 5 attempts is generous. If it hasn't converged by then, the task needs to be broken down or the approach rethought.
