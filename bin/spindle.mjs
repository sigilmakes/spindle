#!/usr/bin/env node

// Spindle CLI
// Usage:
//   spindle run <file.spindle.js>     Execute a script plan
//   spindle lint <file.spindle.js>    Check a script for issues
//   spindle new <name>                Scaffold a new .spindle.js + .md pair
//   spindle                           Show help

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.dirname(__dirname);

const COLORS = {
    red: s => `\x1b[31m${s}\x1b[0m`,
    green: s => `\x1b[32m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    cyan: s => `\x1b[36m${s}\x1b[0m`,
    dim: s => `\x1b[2m${s}\x1b[0m`,
    bold: s => `\x1b[1m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function run(file, flags) {
    if (!file) {
        console.error(COLORS.red("Usage: spindle run <file.spindle.js>"));
        process.exit(1);
    }

    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) {
        console.error(COLORS.red(`File not found: ${resolved}`));
        process.exit(1);
    }

    // Lint first unless --no-lint
    if (!flags.has("--no-lint")) {
        console.log(COLORS.dim("Linting..."));
        const lintExit = await runProcess("node", [path.join(__dirname, "lint-plan.mjs"), resolved]);
        if (lintExit === 2) {
            console.error(COLORS.red("\nScript has errors. Fix them or use --no-lint to skip."));
            process.exit(1);
        }
        if (lintExit === 1) {
            console.log(COLORS.yellow("\nWarnings found. Proceeding anyway.\n"));
        } else {
            console.log("");
        }
    }

    // Build the pi command — interactive mode with the script as initial prompt
    const extensionPath = path.join(ROOT, "src", "index.ts");
    const cwd = path.dirname(resolved);
    const prompt = `Execute this spindle script immediately. Do not read skill files or do orientation — just run it:\n\nspindle_exec({ file: ${JSON.stringify(resolved)} })`;

    const piArgs = [
        "--extension", extensionPath,
    ];

    // Headless mode: process and exit
    if (flags.has("--headless")) {
        piArgs.push("--print");
    }

    // Pass through model flag
    const modelIdx = process.argv.indexOf("--model");
    if (modelIdx !== -1 && process.argv[modelIdx + 1]) {
        piArgs.push("--model", process.argv[modelIdx + 1]);
    }

    piArgs.push(prompt);

    console.log(COLORS.dim(`$ pi ${piArgs.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`));
    console.log("");

    const exitCode = await runProcess("pi", piArgs, { cwd, stdio: "inherit" });
    process.exit(exitCode);
}

async function lint(file) {
    if (!file) {
        console.error(COLORS.red("Usage: spindle lint <file.spindle.js>"));
        process.exit(1);
    }

    const resolved = path.resolve(file);
    const lintScript = path.join(__dirname, "lint-plan.mjs");
    const exitCode = await runProcess("node", [lintScript, resolved], { stdio: "inherit" });
    process.exit(exitCode);
}

async function scaffold(name) {
    if (!name) {
        console.error(COLORS.red("Usage: spindle new <name>"));
        process.exit(1);
    }

    const slug = name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const jsFile = `${slug}.spindle.js`;

    if (fs.existsSync(jsFile)) {
        console.error(COLORS.red(`Already exists: ${jsFile}`));
        process.exit(1);
    }

    const jsContent = `// plan: ${slug}

// === Context ===
CONTEXT = "TODO: describe the goal and constraints"

// === Phase 1: Foundation ===
console.log("=== Phase 1 ===")

// Discover targets from the filesystem
dirs = (await ls({ path: "src/" })).output.split("\\n")
    .filter(d => d.endsWith("/")).map(d => d.slice(0, -1))
console.log("Found:", dirs.join(", "))

ep = await llm(CONTEXT + "\\n\\nTODO: describe the foundation task", { name: "phase-1" })
if (ep.status !== "success") { console.log("Phase 1 failed:", ep.summary); return }

// Verify
await bash({ command: "npm test" })

// === Phase 2: Parallel work ===
console.log("=== Phase 2 ===")

tasks = dirs.map(d => thread(
    CONTEXT + "\\n\\nTODO: describe per-directory task for " + d,
    { name: d }
))
results = await dispatch(tasks)

failures = results.filter(r => r.status !== "success")
if (failures.length) {
    console.log("Failures:", failures.map(f => f.name).join(", "))
}

// === Verify ===
await bash({ command: "npm test" })

// === Summary ===
console.log("\\n=== Results ===")
results.forEach(r => console.log(r.name + ": " + r.status + " ($" + r.cost.toFixed(4) + ")"))
totalCost = results.reduce((s, r) => s + r.cost, 0) + (ep?.cost || 0)
console.log("Total cost: $" + totalCost.toFixed(2))
`;

    fs.writeFileSync(jsFile, jsContent, "utf-8");

    console.log(COLORS.green("✓") + ` Created ${COLORS.cyan(jsFile)}`);
    console.log("");
    console.log("Next steps:");
    console.log(`  1. Edit ${COLORS.bold(jsFile)} — fill in the TODOs`);
    console.log(`  2. ${COLORS.dim("spindle lint " + jsFile)}`);
    console.log(`  3. ${COLORS.dim("spindle run " + jsFile)}`);
}

function help() {
    console.log(`
${COLORS.bold("spindle")} — agent orchestration scripts

${COLORS.bold("Usage:")}
  spindle run  <file.spindle.js>  ${COLORS.dim("Execute a script plan via pi")}
  spindle lint <file.spindle.js>  ${COLORS.dim("Check a script for issues")}
  spindle new  <name>             ${COLORS.dim("Scaffold a .spindle.js + .md pair")}

${COLORS.bold("Run options:")}
  --no-lint                       ${COLORS.dim("Skip linting before execution")}
  --headless                      ${COLORS.dim("Run without TUI (process and exit)")}
  --model <model>                 ${COLORS.dim("Override the model for pi")}

${COLORS.bold("Examples:")}
  spindle new refactor-auth
  spindle lint refactor-auth.spindle.js
  spindle run refactor-auth.spindle.js
  spindle run refactor-auth.spindle.js --model claude-sonnet-4-5
`.trim());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runProcess(cmd, args, opts = {}) {
    return new Promise(resolve => {
        const child = spawn(cmd, args, {
            stdio: opts.stdio || "inherit",
            cwd: opts.cwd,
            env: { ...process.env },
        });
        child.on("close", code => resolve(code ?? 1));
        child.on("error", () => resolve(1));
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];
const flags = new Set(args.filter(a => a.startsWith("--")));
const positional = args.filter(a => !a.startsWith("--"));

switch (command) {
    case "run":
        await run(positional[1], flags);
        break;
    case "lint":
        await lint(positional[1]);
        break;
    case "new":
        await scaffold(positional.slice(1).join(" "));
        break;
    default:
        help();
        break;
}
