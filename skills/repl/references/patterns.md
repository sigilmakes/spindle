# REPL Patterns & Recipes

Common workflows, gotchas, and session hygiene for the Spindle REPL.

## The Fundamental Pattern: Load Once, Query Many

This is why the REPL is better than raw tool calls. Load a directory into a variable, then slice it any way you need — no more tool calls, no context waste.

```javascript
// Call 1: Load the codebase
src = await load("src/")
console.log(`${src.size} files loaded`)

// Call 2: Find all exported functions
exports = [...src.entries()].flatMap(([file, content]) => {
    return [...content.matchAll(/export (?:async )?function (\w+)/g)]
        .map(m => ({ file, fn: m[1] }))
})
console.log(`${exports.length} exported functions`)

// Call 3: Find unused exports (no re-reading, no tool calls)
unused = exports.filter(({ fn, file }) => {
    return ![...src.entries()].some(([f, c]) => f !== file && c.includes(fn))
})
```

Each call builds on previous variables. The `src` Map stays in memory across calls. You can `grep` it, count lines, extract patterns, cross-reference — all in JS, all instant.

### Common Map Operations

```javascript
src = await load("src/")

// File sizes
[...src.entries()]
    .map(([path, content]) => ({ path, lines: content.split("\n").length }))
    .sort((a, b) => b.lines - a.lines)

// Just file names
[...src.keys()]

// Filter by extension
[...src.keys()].filter(f => f.endsWith(".test.ts"))

// Search content
[...src.entries()].filter(([_, c]) => c.includes("deprecated"))

// Build a dependency graph
[...src.entries()].map(([file, content]) => ({
    file,
    imports: [...content.matchAll(/from ['"]\.\/(.*?)['"]/g)].map(m => m[1])
}))
```

## ToolResult Gotchas

All builtins (`grep`, `find`, `ls`, `read`, `bash`, etc.) return `ToolResult { output, error, ok, exitCode }`.

**Empty lines.** `.output.split("\n")` almost always has a trailing empty string. Chain `.filter(Boolean)`:

```javascript
// ✗ Last element is ""
hits.output.split("\n")

// ✓ Clean array
hits.output.split("\n").filter(Boolean)
```

**Errors go to `.error`, not `.output`.** A failed grep returns an empty `.output`. Check `.ok` first:

```javascript
result = await bash({ command: "npm test" })
if (!result.ok) {
    console.log("Failed:", result.error)
} else {
    console.log(result.output)
}
```

**String coercion.** `${result}` and `console.log(result)` print `.output` on success, or `.output + .error` on failure. Usually fine for quick inspection, but parse `.output` explicitly when you need structure.

## Variable Hygiene

Bare assignments persist *everything*. In a long session with multiple `load()` calls, memory adds up.

```javascript
// After you're done with a big dataset
clear("src")          // free the Map
clear("results")      // free the episode array

// Check what's lingering
vars()                // lists all persistent variables with type and preview
```

**Rule of thumb:** `clear()` any variable over ~1MB when you're done with it. `load()` of a large directory can easily be 5-10MB.

## Incremental Exploration

Don't load the whole project on the first call. Start narrow, widen as needed.

```javascript
// Start with structure
entries = await ls({ path: "src/" })

// Read the entry point
main = await load("src/index.ts")

// Only load subdirs you actually need
auth = await load("src/auth/")
```

This is cheaper on memory and helps you focus. Load the world only when you need to cross-reference across the whole codebase.

## Combining Builtins With Load

`grep()` and `find()` are fast for initial discovery. `load()` is better for repeated analysis. Use them together:

```javascript
// grep to find which files matter
hits = await grep({ pattern: "TODO|FIXME", path: "src/" })
todoFiles = [...new Set(hits.output.split("\n").map(l => l.split(":")[0]).filter(Boolean))]

// load just those files for deeper analysis
for (const f of todoFiles) {
    content = await load(f)
    // ... extract, count, categorize
}
```
