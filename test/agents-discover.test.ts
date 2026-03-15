import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock getAgentDir so user-level agents don't interfere with tests.
// Point it at a nonexistent dir so loadAgentsFromDir returns [].
const fakeUserDir = path.join(os.tmpdir(), "spindle-test-no-such-dir-" + process.pid);
vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return { ...orig, getAgentDir: vi.fn(() => fakeUserDir) };
});

import { discoverAgents } from "../src/agents.js";

const tmpDirs: string[] = [];

function makeTmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-agents-test-"));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
});

function writeAgent(baseDir: string, filename: string, content: string): void {
    const agentsDir = path.join(baseDir, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, filename), content, "utf-8");
}

describe("discoverAgents", () => {
    it("returns empty array when no .pi/agents/ exists", () => {
        const tmp = makeTmp();
        const result = discoverAgents(tmp);
        expect(result).toEqual([]);
    });

    it("discovers project agents from cwd/.pi/agents/ with valid frontmatter", () => {
        const tmp = makeTmp();
        writeAgent(tmp, "scout.md", [
            "---",
            "name: scout",
            "description: A scout agent",
            "tools: read,bash,grep",
            "model: some-model",
            "---",
            "You are a scout.",
        ].join("\n"));

        const result = discoverAgents(tmp);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            name: "scout",
            description: "A scout agent",
            tools: ["read", "bash", "grep"],
            model: "some-model",
            systemPrompt: "You are a scout.",
            source: "project",
        });
        expect(result[0].filePath).toBe(path.join(tmp, ".pi", "agents", "scout.md"));
    });

    it("skips files without required frontmatter (missing name)", () => {
        const tmp = makeTmp();
        writeAgent(tmp, "no-name.md", [
            "---",
            "description: Has no name",
            "---",
            "body",
        ].join("\n"));

        const result = discoverAgents(tmp);
        expect(result).toEqual([]);
    });

    it("skips files without required frontmatter (missing description)", () => {
        const tmp = makeTmp();
        writeAgent(tmp, "no-desc.md", [
            "---",
            "name: nodesc",
            "---",
            "body",
        ].join("\n"));

        const result = discoverAgents(tmp);
        expect(result).toEqual([]);
    });

    it("skips non-.md files", () => {
        const tmp = makeTmp();
        const agentsDir = path.join(tmp, ".pi", "agents");
        fs.mkdirSync(agentsDir, { recursive: true });
        fs.writeFileSync(path.join(agentsDir, "agent.txt"), [
            "---",
            "name: txt-agent",
            "description: Should be ignored",
            "---",
            "body",
        ].join("\n"), "utf-8");

        const result = discoverAgents(tmp);
        expect(result).toEqual([]);
    });

    it("parses tools as comma-separated list", () => {
        const tmp = makeTmp();
        writeAgent(tmp, "worker.md", [
            "---",
            "name: worker",
            "description: A worker",
            "tools: read, bash , grep,find",
            "---",
            "",
        ].join("\n"));

        const result = discoverAgents(tmp);
        expect(result).toHaveLength(1);
        expect(result[0].tools).toEqual(["read", "bash", "grep", "find"]);
    });

    it("handles missing optional fields (no tools, no model)", () => {
        const tmp = makeTmp();
        writeAgent(tmp, "minimal.md", [
            "---",
            "name: minimal",
            "description: Bare minimum",
            "---",
            "Just a prompt.",
        ].join("\n"));

        const result = discoverAgents(tmp);
        expect(result).toHaveLength(1);
        expect(result[0].tools).toBeUndefined();
        expect(result[0].model).toBeUndefined();
        expect(result[0].name).toBe("minimal");
        expect(result[0].description).toBe("Bare minimum");
    });

    it("body after frontmatter becomes systemPrompt", () => {
        const tmp = makeTmp();
        const body = "You are a specialized agent.\n\nFollow these rules:\n1. Be concise\n2. Be correct";
        writeAgent(tmp, "detailed.md", [
            "---",
            "name: detailed",
            "description: Detailed agent",
            "---",
            body,
        ].join("\n"));

        const result = discoverAgents(tmp);
        expect(result).toHaveLength(1);
        expect(result[0].systemPrompt).toBe(body);
    });
});
