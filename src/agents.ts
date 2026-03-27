import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export interface AgentConfig {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    systemPrompt: string;
    source: "user" | "project";
    filePath: string;
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
