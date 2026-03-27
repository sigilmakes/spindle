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
checkpoint = (await bash({ command: "git rev-parse HEAD" })).output.trim()

// === Loop ===
for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Implement
    impl = await llm(`You are working in ${process.cwd()}.

Goal: ${goal}
${feedback ? `\nPrevious review feedback — address ALL of these:\n${feedback}` : ""}

Implement this. Run tests. Make exactly one commit when done.`, {
        name: `impl-${attempt}`
    })

    if (!impl.ok) {
        console.log(`❌ Implementation failed`)
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

If you would merge this as-is, say APPROVED.
If it needs work, say REJECTED and list every specific issue.`, {
        name: `review-${attempt}`
    })

    if (review.text.includes("APPROVED")) {
        console.log(`✅ Approved after ${attempt + 1} attempt(s)`)
        break
    }

    feedback = review.text
    console.log(`🔄 Rejected (${attempt + 1}/${maxAttempts}): ${feedback.slice(0, 200)}`)

    // Reset to checkpoint
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
- **Feedback replaces, not accumulates.** Each rejection gives the implementer only the latest review. If the implementer fixes issue A and introduces issue B, feedback for B won't mention A. If this is a problem, accumulate.
- **Don't loop forever.** 5 attempts is generous. If it hasn't converged by then, the task needs to be broken down.
