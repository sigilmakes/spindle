# Spindle

Agent orchestration extension for [pi](https://github.com/mariozechner/pi). Gives the LLM a persistent JavaScript REPL where sub-agents are callable functions, async generator threads yield structured episodes, and parallel work is dispatched. Based on ideas from [Recursive Language Models](https://arxiv.org/abs/2512.24601) (persistent REPL with variables instead of context stuffing) and [Slate](https://randomlabs.ai/blog/slate) (thread weaving with episode-based checkpoints).

## Install

```bash
# Copy or symlink into your extensions directory
cp -r /path/to/spindle ~/.pi/agent/extensions/spindle

# Or load directly
pi --extension /path/to/spindle/dist/index.js
```

## Programmatic tool calling

Tools are functions. Write code that calls them — loops, filters, pipelines.

```javascript
// Find all TODO comments across the project, grouped by file
output = await grep({ pattern: "TODO|FIXME|HACK", path: "src/" })
todos = output.split("\n").filter(Boolean)
console.log(todos.length + " items found")

// Load an entire directory into a variable (bypasses context window)
project = await load("src/auth/")
console.log(project.size + " files loaded")

// Process each file programmatically
for (const [path, content] of project) {
    if (content.includes("deprecated")) {
        console.log("⚠ " + path + " uses deprecated APIs")
    }
}
```

## Parallel sub-agents

Dispatch threads for work that needs an LLM. All threads run simultaneously.

```javascript
research = await dispatch([
    thread("Find security vulnerabilities in src/auth/", { agent: "scout" }),
    thread("Check test coverage for src/auth/", { agent: "scout" }),
    thread("Review error handling in src/auth/", { agent: "scout" }),
])

// Each episode has: status, summary, findings, artifacts, cost, duration
critical = research.flatMap(ep => ep.findings).filter(f => /critical/i.test(f))
console.log(critical.length + " critical issues")
```

## Programmatic sub-agents

Dispatch sub-agents using for loops and templates rather than manual prompting

```javascript
// Define exploration targets
const targets = [
  { name: "documents", path: "Documents", desc: "PDFs, spreadsheets, and project notes" },
  { name: "downloads", path: "Downloads", desc: "Recent installers, temporary files, and incoming media" },
  { name: "music",     path: "Music",     desc: "Audio library, playlists, and production assets" }
];

const threads = targets.map(t => thread(
  `Explore the folder at $HOME/${t.path}.
   This covers: ${t.desc}.

   1. List all files recursively (skip hidden files and cache).
   2. Identify key file types (docs, media, archives).
   3. Return a concise summary: organization style, disk usage, and notable files.
   Keep it tight — bullet points, not essays.`,
  { name: `scout-${t.name}` }
));

const episodes = await dispatch(threads);

// Store results
const findings = {};
for (let i = 0; i < targets.length; i++) {
  findings[targets[i].name] = {
    status: episodes[i].status,
    summary: episodes[i].summary,
    detail: episodes[i].findings || []
  };
}

// Show status
episodes.forEach((ep, i) => console.log(`${targets[i].name}: ${ep.status}`));
```

## Thread communication

Threads can exchange messages during execution via ranks:

```javascript
results = await dispatch([
    thread("Define the TypeScript types, then broadcast them to the team", { agent: "worker", spindle: true }),
    thread("Wait for types from rank 0, then implement the API", { agent: "worker", spindle: true }),
    thread("Wait for types from rank 0, then write the tests", { agent: "worker", spindle: true }),
], { communicate: true })
```

## Commands

| Command | Purpose |
|---|---|
| `/spindle <task>` | Prime the model for wave-based orchestration |
| `/spindle reset` | Fresh REPL context (preserves built-in functions) |
| `/spindle config subModel <model>` | Set default sub-agent model |
| `/spindle status` | Show variables, usage, config |
| `/spindle run <path.js>` | Execute a script file in the REPL |

## Documentation

- **[API Reference](docs/api.md)** — built-in tools, file I/O, sub-agents, threads, communication, episodes
- **[Architecture](docs/architecture.md)** — source layout and design decisions
- **[Examples](docs/examples.md)** — security audit, coordinated research, stepped threads, recursive spindle

## License

MIT
