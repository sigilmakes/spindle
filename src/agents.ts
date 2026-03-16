import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { EpisodeScanner } from "./episode-scanner.js";

export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    systemPrompt: string;
    source: "user" | "project";
    filePath: string;
}

export interface UsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
}

export interface SubAgentEvent {
    type: "tool_start" | "tool_end" | "text" | "turn" | "episode_chunk";
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    text?: string;
    usage?: UsageStats;
    episodeRaw?: string;
    outputBytes?: number;
}

export interface SubAgentResult {
    text: string;
    messages: Message[];
    usage: UsageStats;
    model?: string;
    exitCode: number;
    error?: string;
    durationMs: number;
    outputBytes: number;
}

export interface SpawnOptions {
    agent?: string;
    model?: string;
    tools?: string[];
    systemPromptSuffix?: string;
    cwd?: string;
    timeout?: number;
    spindle?: boolean;
    env?: Record<string, string>;
    onEvent?: (event: SubAgentEvent) => void;
}

// Set by the extension entry point at registration time so sub-agents
// can be spawned with `--extension <path>` pointing back at this extension.
let extensionDir: string | null = null;

export function setExtensionDir(dir: string): void {
    extensionDir = dir;
}

export function getExtensionDir(): string | null {
    return extensionDir;
}

const activeProcesses = new Set<ChildProcess>();

export function discoverAgents(cwd: string): AgentConfig[] {
    const agents: AgentConfig[] = [];

    const userDir = path.join(getAgentDir(), "agents");
    agents.push(...loadAgentsFromDir(userDir, "user"));

    let dir = cwd;
    while (true) {
        const candidate = path.join(dir, ".pi", "agents");
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            agents.push(...loadAgentsFromDir(candidate, "project"));
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    return agents;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
    if (!fs.existsSync(dir)) return [];

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return []; }

    const agents: AgentConfig[] = [];
    for (const entry of entries) {
        if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;

        let content: string;
        try { content = fs.readFileSync(path.join(dir, entry.name), "utf-8"); }
        catch { continue; }

        const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
        if (!frontmatter.name || !frontmatter.description) continue;

        const tools = frontmatter.tools?.split(",").map((t: string) => t.trim()).filter(Boolean);
        agents.push({
            name: frontmatter.name,
            description: frontmatter.description,
            tools: tools?.length ? tools : undefined,
            model: frontmatter.model,
            systemPrompt: body,
            source,
            filePath: path.join(dir, entry.name),
        });
    }
    return agents;
}

export function resolveAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
    return agents.find((a) => a.name === name);
}

function writeTempPrompt(content: string): { dir: string; filePath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-"));
    const filePath = path.join(dir, "prompt-suffix.md");
    fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
    return { dir, filePath };
}

function getFinalText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant") {
            for (const part of msg.content) {
                if (part.type === "text") return part.text;
            }
        }
    }
    return "";
}

function emptyUsage(): UsageStats {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/**
 * Prune large content from intermediate messages to free memory.
 * Keeps the last assistant message intact (final output).
 * Keeps assistant message structure (toolCall parts) for countToolCalls.
 * Replaces large text content in tool results and non-final messages.
 */
export function pruneMessages(messages: Message[]): Message[] {
    if (messages.length === 0) return messages;

    // Find the index of the last assistant message
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant") {
            lastAssistantIdx = i;
            break;
        }
    }

    return messages.map((msg, i) => {
        // Keep last assistant message intact — it's the final output
        if (i === lastAssistantIdx) return msg;

        // For assistant messages, keep structure (toolCall parts stay for counting)
        // but prune large text parts
        if (msg.role === "assistant") {
            return {
                ...msg,
                content: msg.content.map(part => {
                    if (part.type === "text" && part.text.length > 200) {
                        return { ...part, text: `[pruned: ${part.text.length} chars]` };
                    }
                    return part;
                }),
            };
        }

        // For tool results, prune large text content
        if (msg.role === "toolResult") {
            return {
                ...msg,
                content: msg.content.map(part => {
                    if (part.type === "text" && part.text.length > 200) {
                        return { ...part, text: `[pruned: ${part.text.length} chars]` };
                    }
                    return part;
                }),
            };
        }

        return msg;
    });
}

export async function spawnSubAgent(
    task: string,
    options: SpawnOptions & { defaultCwd: string; defaultModel?: string },
    signal?: AbortSignal,
): Promise<SubAgentResult> {
    const start = Date.now();
    const agents = discoverAgents(options.defaultCwd);

    if (options.agent) {
        const config = resolveAgent(agents, options.agent);
        if (!config) {
            const available = agents.map((a) => a.name).join(", ") || "none";
            return {
                text: `Unknown agent: "${options.agent}". Available: ${available}`,
                messages: [], usage: emptyUsage(), exitCode: 1,
                error: `Unknown agent: "${options.agent}"`, durationMs: Date.now() - start,
                outputBytes: 0,
            };
        }
    }

    const agentConfig = options.agent ? resolveAgent(agents, options.agent) : undefined;
    const args: string[] = ["--mode", "json", "-p", "--no-session"];

    const model = options.model ?? agentConfig?.model ?? options.defaultModel;
    if (model) args.push("--model", model);

    const tools = options.tools ?? agentConfig?.tools;
    if (tools?.length) args.push("--tools", tools.join(","));

    // Recursive Spindle: give the sub-agent its own Spindle REPL
    if (options.spindle && extensionDir) {
        // Prefer compiled .js (fast) over .ts (jiti compile on every spawn)
        const extPathJs = path.join(extensionDir, "index.js");
        const extPathTs = path.join(extensionDir, "index.ts");
        const extPath = fs.existsSync(extPathJs) ? extPathJs : extPathTs;
        if (fs.existsSync(extPath)) {
            args.push("--extension", extPath);
        }
    }

    let tmpDir: string | null = null;
    let tmpFile: string | null = null;

    const promptParts: string[] = [];
    if (agentConfig?.systemPrompt?.trim()) promptParts.push(agentConfig.systemPrompt);
    if (options.systemPromptSuffix?.trim()) promptParts.push(options.systemPromptSuffix);

    if (promptParts.length > 0) {
        const tmp = writeTempPrompt(promptParts.join("\n\n"));
        tmpDir = tmp.dir;
        tmpFile = tmp.filePath;
        args.push("--append-system-prompt", tmpFile);
    }

    args.push(`Task: ${task}`);

    const messages: Message[] = [];
    const usage = emptyUsage();
    let stderr = "";
    let processModel: string | undefined;
    let errorMessage: string | undefined;
    let totalOutputBytes = 0;
    const onEvent = options.onEvent;
    const episodeScanner = new EpisodeScanner();

    try {
        if (signal?.aborted) throw new Error("Aborted before spawn");

        const exitCode = await new Promise<number>((resolve) => {
            const proc = spawn("pi", args, {
                cwd: options.cwd ?? options.defaultCwd,
                shell: false,
                stdio: ["ignore", "pipe", "pipe"],
                env: options.env ? { ...process.env, ...options.env } : undefined,
            });
            activeProcesses.add(proc);
            let buffer = "";

            const processLine = (line: string) => {
                if (!line.trim()) return;
                let event: Record<string, unknown>;
                try { event = JSON.parse(line); } catch { return; }

                if (event.type === "tool_execution_start") {
                    onEvent?.({
                        type: "tool_start",
                        toolName: event.toolName as string,
                        toolArgs: event.args as Record<string, unknown>,
                    });
                }

                if (event.type === "tool_execution_end") {
                    onEvent?.({ type: "tool_end", toolName: event.toolName as string });
                }

                if (event.type === "message_end" && event.message) {
                    const msg = event.message as Message;
                    messages.push(msg);
                    if (msg.role === "assistant") {
                        usage.turns++;
                        const u = msg.usage as unknown as Record<string, unknown> | undefined;
                        if (u) {
                            usage.input += (u.input as number) || 0;
                            usage.output += (u.output as number) || 0;
                            usage.cacheRead += (u.cacheRead as number) || 0;
                            usage.cacheWrite += (u.cacheWrite as number) || 0;
                            usage.cost += ((u.cost as Record<string, number>)?.total as number) || 0;
                            usage.contextTokens = (u.totalTokens as number) || 0;
                        }
                        if (!processModel && msg.model) processModel = msg.model as string;
                        if (msg.errorMessage) errorMessage = msg.errorMessage as string;

                        for (const part of msg.content) {
                            if (part.type === "text") {
                                onEvent?.({ type: "text", text: part.text });

                                // Incremental episode scan — O(N) total instead of O(N×T)
                                const newBlocks = episodeScanner.append(part.text);
                                if (onEvent) {
                                    for (const block of newBlocks) {
                                        onEvent({ type: "episode_chunk", episodeRaw: block });
                                    }
                                }
                            }
                        }

                        onEvent?.({ type: "turn", usage: { ...usage }, outputBytes: totalOutputBytes });
                    }
                }

                if (event.type === "tool_result_end" && event.message) {
                    messages.push(event.message as Message);
                }
            };

            proc.stdout!.on("data", (data: Buffer) => {
                totalOutputBytes += data.length;
                buffer += data.toString();
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";
                for (const line of lines) processLine(line);
            });

            proc.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });

            proc.on("close", (code) => {
                if (buffer.trim()) processLine(buffer);
                activeProcesses.delete(proc);
                resolve(code ?? 0);
            });

            proc.on("error", () => { activeProcesses.delete(proc); resolve(1); });

            if (signal) {
                const kill = () => {
                    proc.kill("SIGTERM");
                    setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
                };
                if (signal.aborted) kill();
                else signal.addEventListener("abort", kill, { once: true });
            }

            if (options.timeout) {
                setTimeout(() => {
                    if (!proc.killed) {
                        proc.kill("SIGTERM");
                        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
                    }
                }, options.timeout);
            }
        });

        return {
            text: getFinalText(messages),
            messages: pruneMessages(messages),
            usage,
            model: processModel, exitCode,
            error: errorMessage || (exitCode !== 0 ? stderr : undefined),
            durationMs: Date.now() - start,
            outputBytes: totalOutputBytes,
        };
    } finally {
        if (tmpFile) try { fs.unlinkSync(tmpFile); } catch {}
        if (tmpDir) try { fs.rmdirSync(tmpDir); } catch {}
    }
}

export function killAllSubAgents(): void {
    for (const proc of activeProcesses) {
        proc.kill("SIGTERM");
        setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
    }
    activeProcesses.clear();
}
