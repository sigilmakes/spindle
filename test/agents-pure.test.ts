import { describe, it, expect } from "vitest";
import {
    setExtensionDir,
    getExtensionDir,
    resolveAgent,
    killAllSubAgents,
    type AgentConfig,
} from "../src/agents.js";

// -- setExtensionDir / getExtensionDir ----------------------------------------

describe("setExtensionDir / getExtensionDir", () => {
    it("set then get returns the value", () => {
        setExtensionDir("/tmp/test-ext");
        expect(getExtensionDir()).toBe("/tmp/test-ext");
    });

    it("set overwrites previous value", () => {
        setExtensionDir("/first");
        setExtensionDir("/second");
        expect(getExtensionDir()).toBe("/second");
    });
});

// -- resolveAgent -------------------------------------------------------------

function makeAgent(name: string): AgentConfig {
    return {
        name,
        description: `${name} agent`,
        systemPrompt: "",
        source: "user",
        filePath: `/agents/${name}.md`,
    };
}

describe("resolveAgent", () => {
    const agents = [makeAgent("scout"), makeAgent("worker"), makeAgent("reviewer")];

    it("finds agent by name", () => {
        const result = resolveAgent(agents, "worker");
        expect(result).toBeDefined();
        expect(result!.name).toBe("worker");
    });

    it("returns undefined for unknown name", () => {
        expect(resolveAgent(agents, "nonexistent")).toBeUndefined();
    });

    it("returns first match if duplicates exist", () => {
        const dupes = [
            { ...makeAgent("dup"), description: "first" },
            { ...makeAgent("dup"), description: "second" },
        ];
        const result = resolveAgent(dupes, "dup");
        expect(result).toBeDefined();
        expect(result!.description).toBe("first");
    });

    it("returns undefined for empty agents list", () => {
        expect(resolveAgent([], "scout")).toBeUndefined();
    });
});

// -- killAllSubAgents ---------------------------------------------------------

describe("killAllSubAgents", () => {
    it("does not throw when no active processes exist", () => {
        expect(() => killAllSubAgents()).not.toThrow();
    });
});
