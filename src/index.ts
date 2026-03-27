import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Repl } from "./repl.js";
import { createToolWrappers, createFileIO } from "./tools.js";
import { createDiff, retry, createContextTools } from "./builtins.js";
import { setExtensionDir } from "./agents.js";
import { mcpList, mcpCall, mcpConnect, mcpDisconnect, mcpCleanup } from "./mcp.js";
import {
    formatCodeForDisplay, formatFileExecForDisplay, formatExecResult, formatStatusResult,
    type SpindleExecDetails, type SpindleStatusDetails,
} from "./render.js";

// Register the extension directory so workers can be spawned with --extension
// pointing back at this extension's source entry point.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
setExtensionDir(__dirname);

export default function spindle(pi: ExtensionAPI) {
    /** Names of all injected builtins — used by vars()/clear() to exclude from user variables. */
    const BUILTIN_NAMES = new Set([
        // vm context primitives
        "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
        "Promise", "URL", "TextEncoder", "TextDecoder",
        // tool wrappers
        "read", "bash", "grep", "find", "edit", "write", "ls",
        // file I/O
        "load", "save",
        // MCP
        "mcp", "mcp_call", "mcp_connect", "mcp_disconnect",
        // utilities
        "sleep", "diff", "retry", "vars", "clear", "help",
    ]);

    let repl: Repl | null = null;
    let cwd = process.cwd();
    let subModel: string | undefined;
    let sessionFile: string | undefined;

    const cumulativeUsage = { totalCost: 0, totalLlmCalls: 0 };

    // Per-exec state — threaded through closures
    let currentOnUpdate: AgentToolUpdateCallback<SpindleExecDetails> | undefined;
    let currentSignal: AbortSignal | undefined;
    let currentCode = "";

    function initRepl(workingDir: string): Repl {
        const r = new Repl();
        cwd = workingDir;

        r.inject(createToolWrappers(cwd));

        const fileIO = createFileIO(cwd);
        r.inject({ load: fileIO.load, save: fileIO.save });

        r.inject({
            sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
        });

        // --- MCP builtins ---
        r.inject({
            mcp: mcpList,
            mcp_call: mcpCall,
            mcp_connect: mcpConnect,
            mcp_disconnect: mcpDisconnect,
        });

        // --- Utility builtins: diff, retry, vars, clear ---
        r.inject({ diff: createDiff(cwd), retry });

        const ctxTools = createContextTools(r, BUILTIN_NAMES);
        r.inject({ vars: ctxTools.vars, clear: ctxTools.clear });

        // --- help() — discoverability without the skill doc ---
        r.inject({
            help: () => [
                "=== Spindle REPL ===",
                "",
                "Tools (return ToolResult { output, error, ok, exitCode }):",
                "  read({ path })              Read a file",
                "  edit({ path, oldText, newText })  Replace exact text in a file",
                "  write({ path, content })    Create or overwrite a file",
                "  bash({ command, timeout? }) Run a shell command",
                "  grep({ pattern, path })     Search with ripgrep",
                "  find({ pattern, path })     Find files by glob",
                "  ls({ path })                List directory contents",
                "",
                "File I/O (bypasses context window):",
                "  load(path)                  File → string, directory → Map<path, content>",
                "  save(path, content)         Write without entering context",
                "",
                "MCP (Model Context Protocol):",
                "  mcp()                       List MCP servers",
                "  mcp('server')               List tools for a server",
                "  mcp_call(server, tool, args) One-shot tool call → ToolResult",
                "  mcp_connect(server)         Persistent proxy → ServerProxy",
                "  mcp_disconnect(server?)     Close MCP connections",
                "",
                "Utilities:",
                "  sleep(ms)                   Async delay",
                "  diff(a, b, opts?)           Unified diff (files or strings)",
                "  retry(fn, opts?)            Exponential backoff (attempts, delay, backoff)",
                "  vars()                      List persistent REPL variables",
                "  clear(name?)                Free a variable",
                "  help()                      This message",
                "",
                "Scoping: const, let, var, and bare assignments all persist across calls.",
            ].join("\n"),
        });

        return r;
    }

    // Fast-path: when the prompt is a direct script execution request (from CLI),
    // strip the system prompt to bare minimum so the agent just calls the tool.
    let scriptExecMode = false;

    pi.on("input", async (event) => {
        if (event.text.includes("spindle_exec({ file:") && event.text.includes("Execute this spindle script")) {
            scriptExecMode = true;
            const match = event.text.match(/spindle_exec\(\{[^}]+\}\)/);
            if (match) {
                return { action: "transform" as const, text: match[0] };
            }
        }
        return { action: "continue" as const };
    });

    pi.on("before_agent_start", async (event) => {
        if (scriptExecMode) {
            scriptExecMode = false;
            return {
                systemPrompt: "You are a script runner. Call the spindle_exec tool exactly as specified. No other actions.",
            };
        }
    });

    pi.on("session_start", async (_event, ctx) => {
        repl = initRepl(ctx.cwd);
        sessionFile = ctx.sessionManager.getSessionFile();

        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i] as any;
            if (entry.customType === "spindle-config") {
                if (entry.data?.subModel !== undefined && subModel === undefined) {
                    subModel = entry.data.subModel;
                }
            }
        }
    });

    pi.on("session_shutdown", async () => {
        // TODO: kill running workers, clean up tmux sessions
        await mcpCleanup();
        repl = null;
    });

    pi.registerTool({
        name: "spindle_exec",
        label: "Spindle",
        description: "Execute JavaScript in a persistent REPL with built-in tools, file I/O, and MCP integration.",
        parameters: Type.Object({
            code: Type.Optional(Type.String({ description: "JavaScript code to execute" })),
            file: Type.Optional(Type.String({ description: "Path to a .js or .mjs file to execute (alternative to code)" })),
        }),
        promptGuidelines: [
            [
                "Use spindle_exec when you need to chain operations, transform data in JS, or persist state across calls.",
                "Use native tools (read, edit, write, bash, etc.) for single straightforward operations.",
                "",
                "Inside spindle_exec, think in JavaScript, not bash. Use grep/find/load builtins to get data, then JS to transform it.",
                "  ✗ bash({command: \"find src -name '*.ts' | xargs grep 'export' | awk ...\"})  ← shell for data extraction",
                "  ✓ hits = await grep({pattern: 'export class', path: 'src/'})                  ← builtin + JS filtering",
                "  ✓ src = await load('src/'); [...src.entries()].filter(...)                     ← load + transform",
                "bash() is for builds, tests, git — tools that DO things. Not for searching or data extraction.",
                "",
                "const, let, var, and bare assignments all persist across calls.",
                "",
                "Search: grep({pattern,path}), find({pattern,path}), ls({path})",
                "Files: read({path}), edit({path,oldText,newText}), write({path,content})",
                "I/O: load(path) → string|Map, save(path, content)",
                "Shell: bash({command}) — for builds/tests/git only",
                "MCP: mcp(server?) → list servers/tools, mcp_call(server, tool, args) → result, mcp_connect(server) → proxy",
                "Utils: sleep(ms), diff(a,b), retry(fn,opts?), vars(), clear(name?), help()",
            ].join("\n"),
        ],

        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            if (!repl) repl = initRepl(ctx.cwd);

            // Validate: exactly one of code or file must be provided
            if (!params.code && !params.file) {
                return {
                    content: [{ type: "text", text: "Error: Either 'code' or 'file' must be provided." }],
                    details: { code: "", error: true } satisfies SpindleExecDetails,
                    isError: true,
                };
            }
            if (params.code && params.file) {
                return {
                    content: [{ type: "text", text: "Error: Provide either 'code' or 'file', not both." }],
                    details: { code: "", error: true } satisfies SpindleExecDetails,
                    isError: true,
                };
            }

            // Resolve code — either inline or from file
            let code: string;
            let file: string | undefined;

            if (params.file) {
                file = params.file;
                const resolved = path.resolve(ctx.cwd, file);

                if (!/\.(js|mjs)$/.test(resolved) && !/\.spindle\.js$/.test(resolved)) {
                    return {
                        content: [{ type: "text", text: "Error: File must end in .js, .mjs, or .spindle.js" }],
                        details: { code: "", file, error: true } satisfies SpindleExecDetails,
                        isError: true,
                    };
                }

                try {
                    code = fs.readFileSync(resolved, "utf-8");
                } catch (err: any) {
                    return {
                        content: [{ type: "text", text: `Error reading file: ${err.message}` }],
                        details: { code: "", file, error: true } satisfies SpindleExecDetails,
                        isError: true,
                    };
                }
            } else {
                code = params.code!;
            }

            currentOnUpdate = onUpdate;
            currentSignal = signal;
            currentCode = code;

            try {
                const result = await repl.exec(code, {
                    signal,
                    hoist: !file,
                });

                const parts: string[] = [];
                if (result.output) parts.push(result.output);
                if (result.error) parts.push(`Error: ${result.error}`);

                return {
                    content: [{ type: "text", text: parts.join("\n") || "(no output)" }],
                    details: {
                        code,
                        file,
                        durationMs: result.durationMs,
                        error: !!result.error,
                    } satisfies SpindleExecDetails,
                    isError: !!result.error,
                };
            } finally {
                currentOnUpdate = undefined;
                currentSignal = undefined;
            }
        },

        renderCall(args, theme) {
            if (args.file) {
                return new Text(formatFileExecForDisplay(args.file, theme), 0, 0);
            }
            return new Text(formatCodeForDisplay(args.code || "", theme), 0, 0);
        },

        renderResult(result, options, theme) {
            return new Text(formatExecResult(result as AgentToolResult<SpindleExecDetails>, options.expanded, theme), 0, 0);
        },
    });

    pi.registerTool({
        name: "spindle_status",
        label: "Spindle Status",
        description: "Show REPL variables, usage stats, and configuration.",
        parameters: Type.Object({}),

        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            if (!repl) repl = initRepl(ctx.cwd);

            const variables = repl.getVariables();
            const details: SpindleStatusDetails = {
                variables,
                usage: { ...cumulativeUsage },
                config: { subModel, outputLimit: 8192 },
            };

            const varSummary = variables.length > 0
                ? variables.map(v => `  ${v.name}: ${v.type} = ${v.preview}`).join("\n")
                : "  (none)";

            return {
                content: [{ type: "text", text: [
                    "Spindle Status", "", "Variables:", varSummary, "",
                    `Usage: ${cumulativeUsage.totalLlmCalls} sub-agent calls, $${cumulativeUsage.totalCost.toFixed(4)}`,
                    `Config: sub-model=${subModel || "(default)"}`,
                ].join("\n") }],
                details,
            };
        },

        renderResult(result, _options, theme) {
            const details = result.details as SpindleStatusDetails;
            if (!details) {
                const text = result.content[0];
                return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
            }
            return new Text(formatStatusResult(details, theme), 0, 0);
        },
    });

    pi.registerCommand("spindle", {
        description: "Spindle REPL control — reset, config, run scripts",
        async handler(args, ctx) {
            const parts = args.trim().split(/\s+/);
            const sub = parts[0]?.toLowerCase();

            if (sub === "reset") {
                repl?.reset();
                ctx.ui.notify("Spindle REPL reset", "info");
            } else if (sub === "config") {
                const key = parts[1]?.toLowerCase();
                const value = parts.slice(2).join(" ");
                if (key === "submodel" || key === "sub-model") {
                    subModel = value || undefined;
                    pi.appendEntry("spindle-config", { subModel });
                    ctx.ui.notify(`Sub-model set to: ${subModel || "(default)"}`, "info");
                } else {
                    ctx.ui.notify("Usage: /spindle config <subModel> <value>", "warning");
                }
            } else if (sub === "run") {
                const filePath = parts.slice(1).join(" ").trim();
                if (!filePath) {
                    ctx.ui.notify("Usage: /spindle run <path.js>", "warning");
                } else {
                    pi.sendUserMessage(`Execute this script using spindle_exec with the file parameter:\n\nspindle_exec({ file: ${JSON.stringify(filePath)} })`);
                }
            } else if (sub === "status") {
                pi.sendUserMessage("Show Spindle status using the spindle_status tool.");
            } else if (!sub || sub === "help") {
                ctx.ui.notify("Usage: /spindle <reset|config|status|run>", "info");
            } else {
                pi.sendUserMessage(`Use Spindle (spindle_exec) for this task:\n\n${args}`);
            }
        },
    });
}

export { Repl } from "./repl.js";
export { createDiff, retry, createContextTools } from "./builtins.js";
export type { RetryOptions } from "./builtins.js";
export { createToolWrappers, createFileIO, load, save } from "./tools.js";
export { discoverAgents, resolveAgent, setExtensionDir, getExtensionDir } from "./agents.js";
export type { SpindleExecDetails, SpindleStatusDetails } from "./render.js";
export { mcpList, mcpCall, mcpConnect, mcpDisconnect, mcpCleanup } from "./mcp.js";
