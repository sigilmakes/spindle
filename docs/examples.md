# Workflow Examples

## Parallel review

```js
export const meta = {
  name: 'parallel_review',
  description: 'Run N independent reviewers in parallel',
  phases: [
    { title: 'Review', detail: 'Fan out reviewers' },
    { title: 'Synthesize', detail: 'Combine findings' },
  ],
}

phase('Review')
const reviews = await parallel([
  () => agent('Security review for ' + args.path, { label: 'security', phase: 'Review' }),
  () => agent('Test coverage review for ' + args.path, { label: 'tests', phase: 'Review' }),
  () => agent('Style and maintainability review for ' + args.path, { label: 'style', phase: 'Review' }),
])

phase('Synthesize')
const report = await agent(
  'Combine these reviews into a single structured report:\n' +
  reviews.filter(Boolean).join('\n---\n'),
  { label: 'synthesizer', schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'warn', 'fail'] },
      issues: { type: 'array', items: { type: 'string' } },
      suggestions: { type: 'array', items: { type: 'string' } },
    },
    required: ['verdict', 'issues'],
  } },
)

return report
```

## Pipeline scan

```js
export const meta = {
  name: 'codebase_scan',
  description: 'Scan codebase through collect → classify → summarize stages',
  phases: [
    { title: 'Collect' },
    { title: 'Classify' },
    { title: 'Summarize' },
  ],
}

const results = await pipeline(
  args.directories || ['src/', 'lib/', 'test/'],
  (prev, dir) => agent('List key files in ' + dir, { label: 'collect:' + dir, phase: 'Collect' }),
  (files, dir) => agent('Classify these files by purpose:\n' + files, { label: 'classify:' + dir, phase: 'Classify' }),
  (classification, dir) => agent('Summarize the classification for ' + dir + ':\n' + classification, { label: 'summarize:' + dir, phase: 'Summarize' }),
)

return results.filter(Boolean)
```

## Structured extraction

```js
export const meta = {
  name: 'extract_api',
  description: 'Extract structured API surface from code',
}

const api = await agent(
  'Analyze the public API surface of this codebase. Return endpoints, types, and dependencies.',
  {
    label: 'api-extractor',
    schema: {
      type: 'object',
      properties: {
        endpoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string' },
              path: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['method', 'path'],
          },
        },
        types: { type: 'array', items: { type: 'string' } },
        dependencies: { type: 'array', items: { type: 'string' } },
      },
      required: ['endpoints'],
    },
  },
)

return api
```

## Phased audit with caching

```js
export const meta = {
  name: 'security_audit',
  description: 'Multi-phase security audit with caching',
  phases: [
    { title: 'Discovery' },
    { title: 'Deep scan' },
    { title: 'Report' },
  ],
}

phase('Discovery')
const surfaces = await agent('Find all security-sensitive code surfaces', { label: 'surfaces' })

phase('Deep scan')
const deepResults = await parallel([
  () => agent('Deep scan auth surfaces:\n' + surfaces, { label: 'auth', phase: 'Deep scan', cache: 'auto' }),
  () => agent('Deep scan input validation surfaces:\n' + surfaces, { label: 'validation', phase: 'Deep scan', cache: 'auto' }),
  () => agent('Deep scan crypto surfaces:\n' + surfaces, { label: 'crypto', phase: 'Deep scan', cache: 'auto' }),
])

phase('Report')
const report = await agent(
  'Write a security audit report from these findings:\n' +
  deepResults.filter(Boolean).join('\n===\n'),
  { label: 'reporter' },
)

return report
```

## Retry with resilience

```js
export const meta = {
  name: 'resilient_check',
  description: 'Check with retries for flaky operations',
}

// Failures return null; retries happen automatically
const result = await agent('Run the flaky integration test suite and report results', {
  label: 'flaky-test-runner',
  retries: 2,
  phase: 'Check',
})

if (result === null) {
  return { ok: false, error: 'All retries exhausted' }
}

return result
```