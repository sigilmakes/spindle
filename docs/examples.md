# Examples

## Explore a codebase

```js
spindle({ code: `
r = await subagent("find all authentication-related code and summarize the auth flow")
console.log(r.summary)
r.findings.forEach(f => console.log("-", f))
` })
```

## Scratch thread: parallel review

```js
spindle({ code: `
phase("Review")
const reviews = await parallel([
    () => agent("Review src/auth for security issues", { label: "security" }),
    () => agent("Review src/auth for missing tests", { label: "tests" }),
    () => agent("Review src/auth for maintainability", { label: "maintainer" }),
], { concurrency: 3 })

return answer.done(reviews.map(r => ({ status: r.status, summary: r.summary, findings: r.findings })))
` })
```

## Saved thread

Create `.pi/threads/review.js`:

```js
export const meta = {
    name: "review",
    description: "Parallel specialist review for a target path",
    phases: [
        { title: "Scan", detail: "Understand the target" },
        { title: "Review", detail: "Shard specialist reviewers" },
    ],
}

phase("Scan")
const scout = await agent(`Map the important files and risks in ${args.path}`, { label: "scout" })

phase("Review")
const reviews = await parallel([
    () => agent(`Security review for ${args.path}`, { label: "security" }),
    () => agent(`Test-gap review for ${args.path}`, { label: "tests" }),
])

return answer.done({ scout, reviews })
```

Run it:

```js
spindle({ name: "review", args: { path: "src/" } })
```

## Structured extraction

```js
spindle({ code: `
phase("Extract")
const result = await agent("Extract package metadata from package.json", {
    label: "extractor",
    schema: {
        type: "object",
        required: ["name", "scripts"],
        properties: {
            name: { type: "string" },
            scripts: { type: "object" },
        },
    },
})
return answer.done(result)
` })
```

## Implement with worktree

```js
spindle({ code: `
r = await subagent("add input validation to all API endpoints", { worktree: true })
if (r.ok) {
    await bash({ command: `git merge ${r.branch}` })
}
` })
```

## Pipeline: analyze then fix

```js
spindle({ code: `
phase("Analyze")
analysis = await agent("Identify the top 3 refactoring opportunities in src/", {
    schema: {
        type: "object",
        required: ["items"],
        properties: { items: { type: "array", items: { type: "string" } } },
    },
})

phase("Implement")
results = await parallel(analysis.items.map(item => () =>
    agent(`Implement safely in an isolated worktree: ${item}`, { worktree: true, label: item.slice(0, 32) })
))

return answer.done(results)
` })
```

## Inspect

```js
spindle({ inspect: "threads" })
spindle({ inspect: "status" })
```

Operator commands:

```text
/spindle threads
/spindle run review
/spindle save-thread review
```
