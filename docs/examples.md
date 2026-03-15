# Worked Examples

Three end-to-end examples showing how Spindle cells compose into multi-step workflows. Each example is meant to be run cell-by-cell in the REPL — variables persist between cells, so later cells can reference results from earlier ones.

---

## Security Audit

A four-cell pipeline: scan for code smells, dispatch scouts to find vulnerabilities, plan fixes, apply them, and generate a report.

### Cell 1 — Scan and research

Enumerate source files, grep for obvious red flags, then dispatch two scouts in parallel to do deeper analysis.

```javascript
// Quick surface scan
files = (await find({ path: "src/auth/", pattern: "*.ts" })).trim().split("\n")
smells = await grep({ pattern: "(eval\\(|hardcoded|md5|sha1)", path: "src/auth/" })
console.log(files.length + " files, " + (smells ? smells.split("\n").length : 0) + " smells")

// Two scouts, two angles, run in parallel
research = await dispatch([
    thread("Analyze src/auth/ for authentication bypass, weak token handling, and session management issues. Read every file.", { agent: "scout" }),
    thread("Analyze src/auth/ for injection vulnerabilities, XSS, and CSRF. Read every file.", { agent: "scout" }),
])

// Quick check
for (const ep of research) {
    console.log("[" + ep.status + "] " + ep.findings.length + " findings, " + ep.duration + "ms")
}
```

### Cell 2 — Plan

Collect findings from both scouts and hand them to a planner to produce a prioritized fix plan.

```javascript
findings = research.map(ep =>
    ep.summary + "\n" + ep.findings.map(f => "- " + f).join("\n")
).join("\n\n")

plan = (await dispatch([
    thread(
        "Security audit findings:\n\n" + findings +
        "\n\nCreate a prioritized fix plan. Group by severity (critical, high, medium, low). " +
        "For each item, name the file and describe the fix concretely.",
        { agent: "planner" }
    )
]))[0]

console.log(plan.summary)
plan.findings.forEach(f => console.log("  " + f))
```

### Cell 3 — Fix and test

Dispatch a worker for each critical/high finding. Run the test suite after all fixes land.

```javascript
critical = plan.findings.filter(f => /critical|high/i.test(f))
console.log(critical.length + " critical/high items to fix")

fixes = await dispatch(
    critical.map(fix =>
        thread("Apply this security fix:\n" + fix + "\n\nEdit the file directly. Run any relevant tests after.", { agent: "worker" })
    )
)

for (const ep of fixes) {
    console.log("[" + ep.status + "] " + ep.summary)
}

// Full test suite
testResult = await bash({ command: "npm test 2>&1" })
passing = !testResult.includes("FAIL")
console.log(passing ? "ALL PASSING" : "FAILURES DETECTED")
```

### Cell 4 — Report

Assemble everything into a markdown report and write it out.

```javascript
report = "# Security Audit Report\n\n"
report += "## Findings\n\n"
report += research.flatMap(ep => ep.findings).map(f => "- " + f).join("\n")
report += "\n\n## Fix Plan\n\n"
report += plan.findings.map(f => "- " + f).join("\n")
report += "\n\n## Applied Fixes\n\n"
report += fixes.map(ep => "- [" + ep.status + "] " + ep.summary).join("\n")
report += "\n\n## Test Status\n\n"
report += passing ? "All tests passing after fixes." : "Some tests failing — manual review needed."
report += "\n"

await save("docs/security-audit.md", report)
console.log("Report written to docs/security-audit.md (" + report.length + " chars)")
```

---

## Coordinated Research with Thread Communication

Multiple scouts investigate different parts of a codebase, then send their findings to a coordinator that synthesizes a unified report. Uses `{ communicate: true }` so threads can exchange messages by rank.

### Cell 1 — Dispatch coordinated team

The coordinator (rank 0) waits for messages from three scouts (ranks 1–3). Each scout researches a different area and sends findings when done.

```javascript
results = await dispatch([
    thread(
        "You are the coordinator (rank 0 of 4). " +
        "Wait for findings from ranks 1, 2, and 3 using spindle_recv. " +
        "Once you have all three, synthesize a unified architecture report. " +
        "Write it to docs/architecture.md.",
        { agent: "planner" }
    ),
    thread(
        "Research the authentication system in src/auth/. " +
        "Read the key files, understand the auth flow, identify patterns and concerns. " +
        "When done, use spindle_send to send a structured summary to rank 0.",
        { agent: "scout" }
    ),
    thread(
        "Research the database layer in src/db/. " +
        "Read the key files, understand the data model, identify patterns and concerns. " +
        "When done, use spindle_send to send a structured summary to rank 0.",
        { agent: "scout" }
    ),
    thread(
        "Research the API routes in src/routes/. " +
        "Read the key files, understand the routing structure, identify patterns and concerns. " +
        "When done, use spindle_send to send a structured summary to rank 0.",
        { agent: "scout" }
    ),
], { communicate: true })
```

### Cell 2 — Inspect results

```javascript
for (const ep of results) {
    console.log("[" + ep.agent + " | " + ep.status + "] " + ep.summary)
}

// The coordinator should have written the report
report = await load("docs/architecture.md")
console.log("Report length: " + report.length + " chars")
```

---

## Recursive Spindle — Multi-Module Refactor

A top-level worker gets its own Spindle REPL via `{ spindle: true }`. Inside that REPL, it can dispatch sub-threads to parallelize work across modules. This example refactors several modules, where each top-level worker handles one module but may spawn its own sub-workers internally.

### Cell 1 — Discover and dispatch

Find all modules, then dispatch a Spindle-equipped worker per module. Each worker can read files, plan changes, spawn its own sub-agents to apply edits, and run tests — all within its own REPL context.

```javascript
// Find top-level modules
modules = (await ls({ path: "src/" }))
    .split("\n")
    .filter(entry => entry.endsWith("/"))
    .map(entry => "src/" + entry)

console.log("Modules to refactor: " + modules.join(", "))

// Each worker gets spindle: true — it can dispatch its own sub-threads
refactors = await dispatch(
    modules.map(mod =>
        thread(
            "Refactor " + mod + " to use the new error handling pattern:\n" +
            "1. Read all files in the module\n" +
            "2. Identify functions that throw raw errors\n" +
            "3. Use dispatch() to apply fixes in parallel across files\n" +
            "4. Run tests for this module\n\n" +
            "Use your Spindle REPL to load files, dispatch sub-workers, and run tests.",
            { agent: "worker", spindle: true }
        )
    )
)
```

### Cell 2 — Review and report

```javascript
succeeded = refactors.filter(ep => ep.status === "success")
failed = refactors.filter(ep => ep.status !== "success")
console.log(succeeded.length + " modules done, " + failed.length + " need attention")

for (const ep of failed) {
    console.log("\nFAILED: " + ep.task.slice(0, 60))
    console.log("  " + ep.summary)
    ep.blockers.forEach(b => console.log("  BLOCKER: " + b))
}

// Final test run
testResult = await bash({ command: "npm test 2>&1" })
console.log(testResult.includes("FAIL") ? "SOME TESTS FAILING" : "ALL TESTS PASSING")
```

### Cell 3 — Aggregate artifacts

```javascript
allArtifacts = refactors.flatMap(ep => ep.artifacts)
allFindings = refactors.flatMap(ep => ep.findings)

summary = "# Refactor Summary\n\n"
summary += "## Results\n\n"
summary += refactors.map(ep =>
    "- [" + ep.status + "] " + ep.task.split("\n")[0].replace("Refactor ", "")
).join("\n")
summary += "\n\n## Files Modified\n\n"
summary += allArtifacts.map(a => "- " + a).join("\n")
summary += "\n\n## Findings\n\n"
summary += allFindings.map(f => "- " + f).join("\n")
summary += "\n"

await save("docs/refactor-summary.md", summary)
console.log("Summary written (" + allArtifacts.length + " files, " + allFindings.length + " findings)")
```

---

## Patterns Worth Noting

**Variables persist between cells.** `research` from cell 1 is available in cell 2. Store intermediate results in variables rather than re-running expensive dispatches.

**Episodes are your contract.** Every thread produces an episode with `status`, `summary`, `findings`, `artifacts`, `blockers`, `cost`, and `duration`. Filter and branch on these.

**Parallel by default.** `dispatch([...])` runs all threads concurrently. If you need sequencing, use separate cells or `await` individual `llm()` calls.

**Recursive Spindle is opt-in.** Only pass `{ spindle: true }` when the sub-agent genuinely needs to orchestrate — it adds overhead. Most workers are fine without it.

**Communication is point-to-point.** Threads address each other by rank (array index). The coordinator pattern — one thread receives, N threads send — is the most common shape.
