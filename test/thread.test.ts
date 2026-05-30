import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    ThreadManager,
    discoverThreads,
    extractJson,
    formatThreadRun,
    parseThreadMeta,
    runThreadRuntime,
    saveThread,
    validateSchema,
    type ThreadAgentExecutor,
} from "../src/thread/index.js";
import type { AgentResult } from "../src/workers.js";

function agentResult(text: string, overrides: Partial<AgentResult> = {}): AgentResult {
    return {
        status: "success",
        summary: text,
        findings: [],
        artifacts: [],
        blockers: [],
        text,
        ok: true,
        cost: 0.01,
        model: "test-model",
        turns: 1,
        toolCalls: 2,
        durationMs: 5,
        exitCode: 0,
        ...overrides,
    };
}

const fakeAgent: ThreadAgentExecutor = async (prompt) => agentResult(`answer: ${prompt}`);

const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
} as any;

describe("thread schema", () => {
    it("extracts JSON from structured blocks", () => {
        expect(extractJson("before <structured>{\"ok\":true}</structured> after")).toEqual({ ok: true });
    });

    it("validates required properties and additional properties", () => {
        const result = validateSchema({ ok: true, extra: 1 }, {
            type: "object",
            required: ["ok", "name"],
            additionalProperties: false,
            properties: { ok: { type: "boolean" }, name: { type: "string" } },
        });
        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain("$.name");
        expect(result.errors.join("\n")).toContain("$.extra");
    });
});

describe("thread runtime", () => {
    it("parses metadata", () => {
        const meta = parseThreadMeta(`export const meta = { name: "review", description: "Review", phases: [{ title: "Scan" }] };`);
        expect(meta.name).toBe("review");
        expect(meta.phases?.[0].title).toBe("Scan");
    });

    it("runs phased agent scripts and records usage", async () => {
        const script = `
export const meta = { name: "demo", description: "Demo", phases: [{ title: "Scan" }] };
phase("Scan");
const result = await agent("inspect src", { label: "scout" });
return answer.done({ summary: result.summary });
`;
        const { run, result } = await runThreadRuntime({ cwd: process.cwd(), script, agentExecutor: fakeAgent });
        expect(run.status).toBe("done");
        expect(run.phases[0].status).toBe("done");
        expect(run.phases[0].agents[0].label).toBe("scout");
        expect(run.usage.subagents).toBe(1);
        expect(result).toEqual({ summary: "answer: inspect src" });
    });

    it("validates structured agent output", async () => {
        const script = `
export const meta = { name: "extract", description: "Extract" };
return await agent("extract", { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } });
`;
        const structuredAgent: ThreadAgentExecutor = async () => agentResult("<structured>{\"ok\":true}</structured>");
        const { result } = await runThreadRuntime({ cwd: process.cwd(), script, agentExecutor: structuredAgent });
        expect(result).toEqual({ ok: true });
    });

    it("caches repeated agent calls across manager runs", async () => {
        let calls = 0;
        const manager = new ThreadManager({
            cwd: process.cwd(),
            agentExecutor: async (prompt) => {
                calls++;
                return agentResult(`call ${calls}: ${prompt}`);
            },
        });
        const script = `
export const meta = { name: "cache", description: "Cache", phases: [{ title: "Run" }] };
phase("Run");
return await agent("same prompt", { label: "cached" });
`;
        await manager.run({ script });
        const second = await manager.run({ script });
        expect(calls).toBe(1);
        expect(second.run.phases[0].agents[0].status).toBe("cached");
    });
});

describe("thread library", () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-thread-"));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("saves and discovers project threads", () => {
        const script = `export const meta = { name: "saved", description: "Saved thread" }; return answer.done(true);`;
        const file = saveThread(tmp, "saved", script);
        expect(file).toContain(path.join(".pi", "threads", "saved.js"));
        const entries = discoverThreads(tmp);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe("saved");
        expect(entries[0].scope).toBe("project");
    });
});

describe("thread rendering", () => {
    it("formats run phases and logs", async () => {
        const script = `
export const meta = { name: "render", description: "Render", phases: [{ title: "One" }] };
phase("One");
log("hello");
await agent("work", { label: "worker" });
return answer.done("ok");
`;
        const { run } = await runThreadRuntime({ cwd: process.cwd(), script, agentExecutor: fakeAgent });
        const text = formatThreadRun(run, theme, true);
        expect(text).toContain("render");
        expect(text).toContain("Phases");
        expect(text).toContain("worker");
        expect(text).toContain("hello");
    });
});
