#!/usr/bin/env node

// Spindle plan script linter
// Usage: node bin/lint-plan.mjs <file.js> [--fix-backticks]
//
// Checks .js plan scripts for common issues before execution.
// Exit 0 = clean, 1 = has warnings, 2 = has errors.

import * as fs from "node:fs";
import * as vm from "node:vm";
import * as path from "node:path";

const COLORS = {
    red: s => `\x1b[31m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    green: s => `\x1b[32m${s}\x1b[0m`,
    dim: s => `\x1b[2m${s}\x1b[0m`,
    bold: s => `\x1b[1m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkSyntax(code, filePath) {
    const issues = [];

    // Wrap like the REPL does
    const wrapped = `(async () => {\n${code}\n})()`;
    try {
        new vm.Script(wrapped, { filename: filePath });
    } catch (err) {
        const match = err.message.match(/(\d+)/);
        const line = match ? Math.max(1, parseInt(match[1]) - 1) : "?";
        issues.push({
            level: "error",
            line,
            msg: `Syntax error: ${err.message.split("\n")[0]}`,
            hint: "Common cause: nested backticks in template literals. Use string concatenation or load prompts from files.",
        });
    }

    return issues;
}

function checkNestedBackticks(code) {
    const issues = [];
    const lines = code.split("\n");
    let inTemplate = false;
    let templateStart = 0;
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (let j = 0; j < line.length; j++) {
            if (line[j] === "\\" && j + 1 < line.length) {
                j++; // skip escaped char
                continue;
            }
            if (line[j] === "`") {
                if (!inTemplate) {
                    inTemplate = true;
                    templateStart = i + 1;
                    depth = 1;
                } else {
                    depth--;
                    if (depth === 0) inTemplate = false;
                }
            }
            // Detect ${ inside template — increases nesting expectation
            if (inTemplate && line[j] === "$" && j + 1 < line.length && line[j + 1] === "{") {
                // Scan ahead for backtick inside the interpolation
                for (let k = j + 2; k < line.length; k++) {
                    if (line[k] === "`") {
                        issues.push({
                            level: "warning",
                            line: i + 1,
                            msg: "Nested backtick inside template literal",
                            hint: "Use string concatenation instead: '\"text\" + variable + \"more text\"'",
                        });
                        break;
                    }
                    if (line[k] === "}") break;
                }
            }
        }
    }

    return issues;
}

function checkPromptSize(code) {
    const issues = [];
    const lines = code.split("\n");

    // Find string literals (template or concatenated) in thread/llm calls
    // Heuristic: look for thread( or llm( and measure the string arg
    const callPattern = /(?:thread|llm)\s*\(/g;
    let match;
    while ((match = callPattern.exec(code)) !== null) {
        // Find the extent of the string argument
        const start = match.index + match[0].length;
        let parenDepth = 1;
        let stringSize = 0;
        let inString = false;
        let stringChar = "";

        for (let i = start; i < code.length && parenDepth > 0; i++) {
            const ch = code[i];
            if (ch === "\\" && inString) { i++; continue; }

            if (!inString && (ch === "`" || ch === '"' || ch === "'")) {
                inString = true;
                stringChar = ch;
            } else if (inString && ch === stringChar) {
                inString = false;
            } else if (inString) {
                stringSize++;
            }

            if (!inString) {
                if (ch === "(") parenDepth++;
                if (ch === ")") parenDepth--;
                if (ch === ",") {
                    // Past the first arg (the prompt)
                    break;
                }
            }
        }

        if (stringSize > 1024) {
            const lineNum = code.slice(0, match.index).split("\n").length;
            issues.push({
                level: "warning",
                line: lineNum,
                msg: `Large prompt (~${Math.round(stringSize / 1024)}KB) in ${match[0].trim()}`,
                hint: "Pass file paths instead of content. Sub-agents can read files themselves.",
            });
        }
    }

    return issues;
}

function extractCallBody(code, startIndex) {
    let depth = 0;
    for (let i = startIndex; i < code.length; i++) {
        if (code[i] === "(") depth++;
        if (code[i] === ")") { depth--; if (depth === 0) return code.slice(startIndex, i + 1); }
    }
    return code.slice(startIndex);
}

function checkMissingNames(code) {
    const issues = [];

    const callPattern = /(?:thread|llm)\s*\(/g;
    let match;
    while ((match = callPattern.exec(code)) !== null) {
        const fnName = match[0].replace(/\s*\($/, "");
        const body = extractCallBody(code, match.index + fnName.length);
        // Skip calls inside helper functions (retryLlm, loops) — name may be passed dynamically
        const lineNum = code.slice(0, match.index).split("\n").length;
        const surroundingLines = code.split("\n").slice(Math.max(0, lineNum - 10), lineNum);
        const insideHelper = surroundingLines.some(l => /^(async\s+)?function\s|=>\s*\{|for\s*\(|while\s*\(/.test(l.trim()));
        if (insideHelper) continue;
        if (!body.includes("name:") && !body.includes("name :")) {
            const lineNum = code.slice(0, match.index).split("\n").length;
            issues.push({
                level: "warning",
                line: lineNum,
                msg: `${fnName}() without { name: ... }`,
                hint: "Names flow through to episode data and make reports readable.",
            });
        }
    }

    return issues;
}

function checkErrorGates(code) {
    const issues = [];
    const lines = code.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Pattern: ep = await llm(...) or result = await llm(...)
        if (/=\s*await\s+llm\s*\(/.test(line)) {
            // Find the end of this call (matching parens), then look for a status check
            // within the next 5 non-empty lines AFTER the call ends
            let callEndLine = i;
            let depth = 0;
            for (let j = i; j < lines.length; j++) {
                for (const ch of lines[j]) {
                    if (ch === "(") depth++;
                    if (ch === ")") depth--;
                }
                if (depth <= 0) { callEndLine = j; break; }
            }

            let hasGate = false;
            for (let j = callEndLine + 1; j < Math.min(callEndLine + 6, lines.length); j++) {
                if (/\.status/.test(lines[j])) { hasGate = true; break; }
                if (/if\s*\(/.test(lines[j]) && /status|success|fail/.test(lines[j])) { hasGate = true; break; }
                // gate() helper pattern — common in spindle scripts
                if (/gate\s*\(/.test(lines[j])) { hasGate = true; break; }
            }

            // Also skip if the llm() call is inside a helper that manages its own gating
            // (e.g. retryLlm, or a for/while retry loop)
            if (!hasGate) {
                // Check if this llm() is inside a function body
                let insideHelper = false;
                for (let j = i - 1; j >= Math.max(0, i - 15); j--) {
                    const ctx = lines[j].trim();
                    // Inside a retry helper, for loop, or while loop
                    if (/^(async\s+)?function\s|=>\s*\{|for\s*\(|while\s*\(/.test(ctx)) {
                        insideHelper = true;
                        break;
                    }
                    // Hit a top-level phase marker — not inside a helper
                    if (/^\/\/\s*===/.test(ctx)) break;
                }
                if (insideHelper) hasGate = true;
            }

            if (!hasGate) {
                issues.push({
                    level: "warning",
                    line: i + 1,
                    msg: "llm() result not checked for failure",
                    hint: "Gate on ep.status: if (ep.status !== 'success') return",
                });
            }
        }
    }

    return issues;
}

function checkHardcodedPaths(code) {
    const issues = [];

    // Look for quoted absolute paths or ./relative paths inside thread/llm prompts
    // This is heuristic — may false-positive on intentional paths
    const promptPattern = /(?:thread|llm)\s*\(\s*(`[\s\S]*?`|"[\s\S]*?"|'[\s\S]*?')/gs;
    let match;
    while ((match = promptPattern.exec(code)) !== null) {
        const prompt = match[1];
        const pathMatches = prompt.match(/(?:\/home\/|~\/|\.\/[\w-]+\/[\w-]+)/g);
        if (pathMatches && pathMatches.length > 3) {
            const lineNum = code.slice(0, match.index).split("\n").length;
            issues.push({
                level: "warning",
                line: lineNum,
                msg: `${pathMatches.length} hardcoded paths in prompt`,
                hint: "Derive paths from ls()/find() instead of hand-typing them.",
            });
        }
    }

    return issues;
}

function checkMissingVerification(code) {
    const issues = [];

    const hasDispatch = /dispatch\s*\(/.test(code);
    const hasLlm = /await\s+llm\s*\(/.test(code);
    const hasTest = /bash\s*\(\s*\{[^}]*(?:test|check|verify|lint|pytest|vitest|jest|flake check)/i.test(code);

    if ((hasDispatch || hasLlm) && !hasTest) {
        issues.push({
            level: "warning",
            line: null,
            msg: "No verification step (test/check/lint) found",
            hint: "Run tests between phases to catch breakage early.",
        });
    }

    return issues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith("-"));
const flags = new Set(args.filter(a => a.startsWith("-")));

if (!filePath) {
    console.log("Usage: lint-plan <file.spindle.js>");
    console.log("");
    console.log("Checks:");
    console.log("  ✗ Syntax errors (nested backticks, bad JS)");
    console.log("  ⚠ Large prompts (>1KB — pass paths, not content)");
    console.log("  ⚠ Missing names on thread()/llm() calls");
    console.log("  ⚠ Missing error gates after llm() calls");
    console.log("  ⚠ Hardcoded paths in prompts");
    console.log("  ⚠ No verification step between phases");
    process.exit(0);
}

let code;
try {
    code = fs.readFileSync(filePath, "utf-8");
} catch (err) {
    console.error(COLORS.red(`Cannot read ${filePath}: ${err.message}`));
    process.exit(2);
}

const issues = [
    ...checkSyntax(code, filePath),
    ...checkNestedBackticks(code),
    ...checkPromptSize(code),
    ...checkMissingNames(code),
    ...checkErrorGates(code),
    ...checkHardcodedPaths(code),
    ...checkMissingVerification(code),
];

const errors = issues.filter(i => i.level === "error");
const warnings = issues.filter(i => i.level === "warning");

if (issues.length === 0) {
    console.log(COLORS.green("✓") + ` ${path.basename(filePath)} — no issues`);
    process.exit(0);
}

const label = path.basename(filePath);
console.log(COLORS.bold(label));
console.log("");

for (const issue of issues) {
    const prefix = issue.level === "error"
        ? COLORS.red("✗ error")
        : COLORS.yellow("⚠ warning");
    const loc = issue.line ? COLORS.dim(`:${issue.line}`) : "";
    console.log(`  ${prefix}${loc}  ${issue.msg}`);
    if (issue.hint) {
        console.log(`    ${COLORS.dim(issue.hint)}`);
    }
}

console.log("");
const summary = [];
if (errors.length) summary.push(COLORS.red(`${errors.length} error${errors.length > 1 ? "s" : ""}`));
if (warnings.length) summary.push(COLORS.yellow(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}`));
console.log(summary.join(", "));

process.exit(errors.length > 0 ? 2 : 1);
