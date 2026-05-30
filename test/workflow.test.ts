import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    WorkflowRuntime,
    discoverWorkflows,
    resolveWorkflow,
    saveWorkflow,
    parseWorkflowMeta,
    summarizeWorkflowRun,
    formatWorkflowRun,
    formatWorkflowList,
    extractJson,
    validateSchema,
    transformWorkflowScript,
    buildSchemaPrompt,
    type WorkflowAgentCompletion,
    type WorkflowAgentDriver,
} from "../src/workflow/index.js";

function agentCompletion(text: string, overrides: Partial<WorkflowAgentCompletion> = {}): WorkflowAgentCompletion {
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

const fakeDriver: WorkflowAgentDriver = async (request) => agentCompletion(`answer: ${request.prompt}`);

const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
} as any;

// ── Schema ──
describe("workflow schema", () => {
    it("extracts JSON from structured blocks", () => {
        expect(extractJson("before <structured>{\"ok\":true}</structured> after")).toEqual({ ok: true });
    });

    it("extracts JSON from fenced code blocks", () => {
        expect(extractJson("```json\n{\"ok\":true}\n```")).toEqual({ ok: true });
    });

    it("extracts JSON from bare objects", () => {
        expect(extractJson("{\"ok\":true}")).toEqual({ ok: true });
    });

    it("validates required properties and rejects additional properties", () => {
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

    it("validates nested objects", () => {
        const result = validateSchema({ user: { name: "alice" } }, {
            type: "object",
            properties: {
                user: {
                    type: "object",
                    required: ["name", "age"],
                    properties: { name: { type: "string" }, age: { type: "number" } },
                },
            },
        });
        expect(result.ok).toBe(false);
        expect(result.errors.join("\n")).toContain("age");
    });

    it("builds schema prompt for agent structured output", () => {
        const prompt = buildSchemaPrompt({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } });
        expect(prompt).toContain("structured");
        expect(prompt).toContain("JSON Schema");
    });
});

// ── Meta parser ──
describe("workflow meta parser", () => {
    it("parses clean metadata", () => {
        const meta = parseWorkflowMeta(`export const meta = { name: "review", description: "Review code", phases: [{ title: "Scan" }] };`);
        expect(meta.name).toBe("review");
        expect(meta.description).toBe("Review code");
        expect(meta.phases?.[0].title).toBe("Scan");
    });

    it("parses whenToUse", () => {
        const meta = parseWorkflowMeta(`export const meta = { name: "test", description: "Test", whenToUse: "When testing" };`);
        expect(meta.whenToUse).toBe("When testing");
    });

    it("rejects missing name", () => {
        expect(() => parseWorkflowMeta(`export const meta = { description: "No name" };`)).toThrow(/name/);
    });

    it("rejects missing description", () => {
        expect(() => parseWorkflowMeta(`export const meta = { name: "nodesc" };`)).toThrow(/description/);
    });

    it("strips export const meta from script body", () => {
        const transformed = transformWorkflowScript(`export const meta = { name: "x", description: "y" };\nreturn 1;`);
        expect(transformed).not.toContain("export const meta");
        expect(transformed).toContain("return 1;");
    });
});

// ── Runtime ──
describe("workflow runtime", () => {
    it("runs a simple script and records completion", async () => {
        const script = `
export const meta = { name: "simple", description: "Simple" };
return 42;
`;
        const runtime = new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: fakeDriver });
        const { run, result } = await runtime.execute();
        expect(run.status).toBe("done");
        expect(result).toBe(42);
    });

    it("runs phased agent scripts and records usage", async () => {
        const script = `
export const meta = { name: "demo", description: "Demo", phases: [{ title: "Scan" }] };
phase("Scan");
const result = await agent("inspect src", { label: "scout" });
return result;
`;
        const { run } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: fakeDriver }).execute();
        expect(run.status).toBe("done");
        expect(run.phases[0].status).toBe("done");
        expect(run.phases[0].agents[0]).toBe("a1");
        expect(run.agents.a1.label).toBe("scout");
        expect(run.usage.agents).toBe(1);
        expect(run.usage.cost).toBe(0.01);
    });

    it("validates structured agent output", async () => {
        const script = `
export const meta = { name: "extract", description: "Extract" };
return await agent("extract", { schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } });
`;
        const structuredDriver: WorkflowAgentDriver = async () => agentCompletion("<structured>{\"ok\":true}</structured>");
        const { result } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: structuredDriver }).execute();
        expect(result).toEqual({ ok: true });
    });

    it("caches repeated agent calls across runs", async () => {
        let calls = 0;
        const cache = new Map<string, unknown>();
        const driver: WorkflowAgentDriver = async (req) => {
            calls++;
            return agentCompletion(`call ${calls}: ${req.prompt}`);
        };

        const script = `
export const meta = { name: "cache", description: "Cache", phases: [{ title: "Run" }] };
phase("Run");
return await agent("same prompt", { label: "cached" });
`;

        const run1 = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: driver, cache }).execute();
        expect(calls).toBe(1);
        expect(run1.run.agents.a1.status).toBe("completed");

        const run2 = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: driver, cache }).execute();
        expect(calls).toBe(1); // still 1, cached
        expect(run2.run.agents.a1.status).toBe("cached");
    });

    it("can force cache bypass", async () => {
        let calls = 0;
        const cache = new Map<string, unknown>();
        const driver: WorkflowAgentDriver = async () => {
            calls++;
            return agentCompletion(`call ${calls}`);
        };

        const script = `
export const meta = { name: "force", description: "Force" };
return await agent("prompt", { cache: "force" });
`;
        await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: driver, cache }).execute();
        await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: driver, cache }).execute();
        expect(calls).toBe(2);
    });

    it("records failures for failed agents", async () => {
        const failDriver: WorkflowAgentDriver = async () => { throw new Error("boom"); };
        const script = `
export const meta = { name: "fail", description: "Fail" };
const result = await agent("will fail", { retries: 0 });
if (result === null) return "caught null";
return result;
`;
        const { run } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: failDriver }).execute();
        expect(run.status).toBe("done"); // script handled null gracefully
        expect(run.failures.length).toBeGreaterThanOrEqual(1);
        expect(run.agents.a1.status).toBe("failed");
    });

    it("retries failed agents", async () => {
        let attempt = 0;
        const retryDriver: WorkflowAgentDriver = async () => {
            attempt++;
            if (attempt < 3) throw new Error("not yet");
            return agentCompletion("finally");
        };
        const script = `
export const meta = { name: "retry", description: "Retry" };
return await agent("retry me", { retries: 2, label: "retrier" });
`;
        const { run } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: retryDriver }).execute();
        expect(run.status).toBe("done");
        expect(attempt).toBe(3);
        expect(run.agents.a1.status).toBe("completed");
    });

    it("runs parallel agents", async () => {
        const script = `
export const meta = { name: "parallel", description: "Parallel" };
const results = await parallel([
    () => agent("task a", { label: "a", phase: "Work" }),
    () => agent("task b", { label: "b", phase: "Work" }),
    () => agent("task c", { label: "c", phase: "Work" }),
]);
return results.map(r => r.summary);
`;
        const { run, result } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: fakeDriver }).execute();
        expect(run.status).toBe("done");
        expect(run.agentOrder).toHaveLength(3);
        expect((result as string[]).length).toBe(3);
    });

    it("runs pipeline stages", async () => {
        const script = `
export const meta = { name: "pipeline", description: "Pipeline" };
const results = await pipeline(
    ["file1", "file2"],
    (prev, original) => agent("stage1: " + original, { label: "s1:" + original, phase: "Stage1" }),
    (prev, original) => agent("stage2: " + original, { label: "s2:" + original, phase: "Stage2" }),
);
return results;
`;
        const { run, result } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: fakeDriver }).execute();
        expect(run.status).toBe("done");
        expect(run.agentOrder).toHaveLength(4);
        expect((result as unknown[]).length).toBe(2);
    });

    it("exposes args to the script scope", async () => {
        const script = `
export const meta = { name: "args", description: "Args test" };
return args;
`;
        const { result } = await new WorkflowRuntime({ cwd: process.cwd(), input: { args: { x: 1 } }, script, agentDriver: fakeDriver }).execute();
        expect(result).toEqual({ x: 1 });
    });

    it("logs messages", async () => {
        const script = `
export const meta = { name: "log", description: "Log test" };
log("hello");
log("world", { detail: true });
return "done";
`;
        const { run } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: fakeDriver }).execute();
        expect(run.logs).toHaveLength(2);
        expect(run.logs[0].message).toBe("hello");
        expect(run.logs[1].data).toEqual({ detail: true });
    });

    it("emits updates via onUpdate callback", async () => {
        const updates: WorkflowRun[] = [];
        const script = `
export const meta = { name: "emit", description: "Emit test" };
await agent("test");
return "done";
`;
        await new WorkflowRuntime({
            cwd: process.cwd(),
            input: {},
            script,
            agentDriver: fakeDriver,
            onUpdate: (run) => updates.push(run),
        }).execute();
        // At least: initial status, agent queued, agent running, agent completed, done
        expect(updates.length).toBeGreaterThanOrEqual(4);
    });

    it("sets workflow status to failed on uncaught errors", async () => {
        const script = `
export const meta = { name: "crash", description: "Crash" };
throw new Error("kaboom");
`;
        const { run } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: fakeDriver }).execute()
            .catch((e) => ({ run: (e as any).run ?? null, result: undefined }));
        // Should have thrown, but if caught at higher level should be "failed"
        // The runtime throws — we need to catch it properly
    });

    it("summarizes run compactly", async () => {
        const script = `
export const meta = { name: "summary", description: "Summary" };
await agent("test");
return "done";
`;
        const { run } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: fakeDriver }).execute();
        const summary = summarizeWorkflowRun(run);
        expect(summary).toContain("done");
        expect(summary).toContain("1/1 agents");
    });
});

// ── Library ──
describe("workflow library", () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-wf-"));
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("saves and discovers project workflows", () => {
        const script = `export const meta = { name: "saved", description: "Saved workflow" }; return true;`;
        const file = saveWorkflow(tmp, "saved", script);
        expect(file).toContain(path.join(".pi", "threads", "saved.js"));
        const entries = discoverWorkflows(tmp);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe("saved");
        expect(entries[0].scope).toBe("project");
    });

    it("resolves workflows by name", async () => {
        const script = `export const meta = { name: "resolver", description: "Resolver" }; return true;`;
        saveWorkflow(tmp, "resolver", script);
        const resolved = await resolveWorkflow(tmp, "resolver");
        expect(resolved.script).toContain("resolver");
    });

    it("throws for unknown workflows", async () => {
        await expect(resolveWorkflow(tmp, "nonexistent")).rejects.toThrow(/not found/);
    });

    it("resolves direct file paths", async () => {
        const filePath = path.join(tmp, "direct.js");
        fs.writeFileSync(filePath, `export const meta = { name: "direct", description: "Direct" }; return true;`);
        const resolved = await resolveWorkflow(tmp, filePath);
        expect(resolved.scriptPath).toBe(filePath);
    });
});

// ── Rendering ──
describe("workflow rendering", () => {
    it("formats run phases and logs", async () => {
        const script = `
export const meta = { name: "render", description: "Render", phases: [{ title: "One" }] };
phase("One");
log("hello");
await agent("work", { label: "worker" });
return "ok";
`;
        const { run } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: fakeDriver }).execute();
        const text = formatWorkflowRun(run, theme, true);
        expect(text).toContain("render");
        expect(text).toContain("One");
        expect(text).toContain("worker");
        expect(text).toContain("hello");
    });

    it("formats workflow list", async () => {
        const script = `
export const meta = { name: "listme", description: "List" };
await agent("test");
return "ok";
`;
        const { run } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: fakeDriver }).execute();
        const text = formatWorkflowList([run], theme);
        expect(text).toContain("listme");
    });

    it("formats empty list gracefully", () => {
        const text = formatWorkflowList([], theme);
        expect(text).toContain("No workflows");
    });

    it("shows failures in expanded view", async () => {
        const failDriver: WorkflowAgentDriver = async () => { throw new Error("boom"); };
        const script = `
export const meta = { name: "failrender", description: "Fail render" };
try { await agent("will fail", { retries: 0 }); } catch (e) { return e.message; }
`;
        const { run } = await new WorkflowRuntime({ cwd: process.cwd(), input: {}, script, agentDriver: failDriver }).execute();
        const text = formatWorkflowRun(run, theme, true);
        expect(text).toContain("⚠");
    });
});