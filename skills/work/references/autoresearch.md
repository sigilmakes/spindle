# Autoresearch Loop

Optimize a measurable metric iteratively. Form hypothesis, make change, measure, keep or revert. Git history is the experiment log.

## When To Use

- Performance optimization (benchmark times, bundle sizes)
- Prompt tuning (accuracy scores, latency)
- Configuration optimization (memory usage, throughput)
- Any work where you can measure "better" vs "worse"

## Template

```javascript
// === Setup ===
benchCmd = "<command that outputs the metric>"
metricName = "<what you're measuring>"
maxIterations = 20

// Baseline
baseResult = await bash({ command: benchCmd })
baseline = parseMetric(baseResult.output)  // you define this
console.log(`Baseline ${metricName}: ${baseline}`)

ideas = [
    "idea 1: description of optimization to try",
    "idea 2: description of another approach",
    // ... or generate dynamically
]

kept = 0
tried = 0

// === Loop ===
for (let i = 0; i < maxIterations && ideas.length > 0; i++) {
    idea = ideas.shift()
    tried++
    console.log(`\n--- Experiment ${tried}: ${idea} ---`)

    // Implement the hypothesis
    impl = await llm(`You are working in ${process.cwd()}.

Current ${metricName}: ${baseline}
Hypothesis: ${idea}

Make the change. Keep it minimal and reversible.
Do NOT commit — we measure first.`, {
        name: `exp-${tried}`
    })

    if (impl.status !== "success") {
        console.log(`❌ Implementation failed, skipping`)
        await bash({ command: "git checkout -- ." })
        continue
    }

    // Measure
    measResult = await bash({ command: benchCmd })
    current = parseMetric(measResult.output)
    improved = current < baseline  // adjust comparison for your metric

    console.log(`${metricName}: ${baseline} → ${current} (${improved ? "✅ better" : "❌ worse"})`)

    if (improved) {
        await bash({ command: `git add -A && git commit -m "perf: ${idea.slice(0, 50)} (${baseline} → ${current})"` })
        baseline = current
        kept++
        console.log(`Kept! New baseline: ${baseline}`)
    } else {
        await bash({ command: "git checkout -- ." })
        console.log(`Reverted.`)
    }
}

// === Report ===
console.log(`\nDone: ${tried} experiments, ${kept} kept`)
console.log(`${metricName}: ${baseline}`)
```

## Generating Ideas

Instead of a static list, generate hypotheses from a sub-agent:

```javascript
ideaGen = await llm(`Analyze the codebase at ${dir}/ for ${metricName} optimization opportunities.

Current ${metricName}: ${baseline}
Already tried: ${triedIdeas.join(", ") || "nothing yet"}

Suggest 5 specific, actionable optimizations. Each should be a single change.
Put each idea as a finding.`, {
    name: "ideagen"
})

ideas = ideaGen.findings
```

Regenerate ideas every N iterations to adapt based on what's worked.

## The parseMetric Function

You need to define this per experiment. Examples:

```javascript
// Parse "Time: 1234ms" from benchmark output
function parseMetric(output) {
    m = output.match(/Time:\s*(\d+)ms/)
    return m ? parseInt(m[1]) : Infinity
}

// Parse bundle size from webpack output
function parseMetric(output) {
    m = output.match(/(\d+\.?\d*)\s*kB/)
    return m ? parseFloat(m[1]) : Infinity
}

// Parse test count
function parseMetric(output) {
    m = output.match(/(\d+) tests passed/)
    return m ? parseInt(m[1]) : 0
}
```

## Gotchas

- **Benchmark noise.** Run the benchmark multiple times and average, or improvements within noise will be falsely kept/rejected.
- **Don't commit before measuring.** The implementation agent must not commit — the loop decides based on the metric.
- **Interaction effects.** Optimization A and B might each help alone but conflict together. Git bisect is your friend.
- **Diminishing returns.** The first few iterations find the big wins. After that, stop and move on.
- **Metric must be automated.** If you can't measure it with a command, this pattern doesn't apply.
