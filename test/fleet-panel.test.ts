import { describe, it, expect, vi } from "vitest";
import { FleetPanel, type FleetAction } from "../src/workflow/fleet-panel.js";
import type { WorkflowRun, WorkflowAgentNode } from "../src/workflow/types.js";

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
    return {
        id: "wf_test_001",
        name: "test-workflow",
        description: "Test workflow",
        status: "done",
        input: {},
        scriptHash: "abc123",
        args: undefined,
        phases: [],
        agents: {},
        agentOrder: [],
        logs: [],
        failures: [],
        usage: { cost: 0, agents: 0, toolCalls: 0, turns: 0 },
        startedAt: Date.now() - 1000,
        updatedAt: Date.now(),
        completedAt: Date.now(),
        ...overrides,
    };
}

function makeAgent(id: string, overrides: Partial<WorkflowAgentNode> = {}): WorkflowAgentNode {
    return {
        id,
        callIndex: 0,
        label: `agent-${id}`,
        promptPreview: "test prompt",
        status: "completed",
        startedAt: Date.now() - 500,
        completedAt: Date.now(),
        durationMs: 500,
        ...overrides,
    };
}

const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
} as any;

describe("FleetPanel", () => {
    it("renders empty runs list", () => {
        const actions: FleetAction[] = [];
        const panel = new FleetPanel(theme, {
            onAction: (a) => actions.push(a),
            onClose: () => {},
        });
        panel.updateRuns([]);
        const lines = panel.render(80);
        expect(lines.some((l) => l.includes("No workflow"))).toBe(true);
    });

    it("renders a list of runs", () => {
        const panel = new FleetPanel(theme, {
            onAction: () => {},
            onClose: () => {},
        });
        const run = makeRun({
            agentOrder: ["a1"],
            agents: { a1: makeAgent("a1") },
            phases: [{ title: "Plan", status: "done", agents: ["a1"], usage: { cost: 0, agents: 1, toolCalls: 0, turns: 0 } }],
        });
        panel.updateRuns([run]);
        const lines = panel.render(80);
        expect(lines.some((l) => l.includes("test-workflow"))).toBe(true);
    });

    it("navigates into phases with Enter", () => {
        const panel = new FleetPanel(theme, {
            onAction: () => {},
            onClose: () => {},
        });
        const run = makeRun({
            agentOrder: ["a1"],
            agents: { a1: makeAgent("a1") },
            phases: [{ title: "Plan", status: "done", agents: ["a1"], usage: { cost: 0, agents: 1, toolCalls: 0, turns: 0 } }],
        });
        panel.updateRuns([run]);

        // Enter drills into phases
        panel.handleInput("\r"); // Enter
        const lines = panel.render(80);
        expect(lines.some((l) => l.includes("Plan"))).toBe(true);
    });

    it("goes back with Escape", () => {
        const panel = new FleetPanel(theme, {
            onAction: () => {},
            onClose: () => {},
        });
        const run = makeRun({
            agentOrder: ["a1"],
            agents: { a1: makeAgent("a1") },
            phases: [{ title: "Plan", status: "done", agents: ["a1"], usage: { cost: 0, agents: 1, toolCalls: 0, turns: 0 } }],
        });
        panel.updateRuns([run]);

        // Drill in, then escape back
        panel.handleInput("\r"); // Enter -> phases
        panel.handleInput("\x1b"); // Escape -> back to runs
        const lines = panel.render(80);
        // Should be back at runs level showing workflow name
        expect(lines.some((l) => l.includes("test-workflow"))).toBe(true);
    });

    it("emits stop action on x key at runs level", () => {
        const actions: FleetAction[] = [];
        const panel = new FleetPanel(theme, {
            onAction: (a) => actions.push(a),
            onClose: () => {},
        });
        const run = makeRun({ status: "running" });
        panel.updateRuns([run]);

        panel.handleInput("x");
        expect(actions.length).toBe(1);
        expect(actions[0].type).toBe("stop");
        expect((actions[0] as any).runId).toBe("wf_test_001");
    });

    it("emits close on Escape at runs level", () => {
        let closed = false;
        const panel = new FleetPanel(theme, {
            onAction: () => {},
            onClose: () => { closed = true; },
        });
        panel.updateRuns([]);
        panel.handleInput("\x1b"); // Escape at top level
        expect(closed).toBe(true);
    });

    it("cache invalidates on updateRuns", () => {
        const panel = new FleetPanel(theme, {
            onAction: () => {},
            onClose: () => {},
        });
        const lines1 = panel.render(80);
        panel.updateRuns([makeRun()]);
        const lines2 = panel.render(80);
        // Lines should change after update
        expect(lines2).not.toBe(lines1);
    });

    it("does not crash with many runs", () => {
        const panel = new FleetPanel(theme, {
            onAction: () => {},
            onClose: () => {},
        });
        const runs = Array.from({ length: 50 }, (_, i) => makeRun({ id: `wf_${i}`, name: `run-${i}` }));
        panel.updateRuns(runs);
        const lines = panel.render(80);
        // Should render without error and contain at least one run
        expect(lines.length).toBeGreaterThan(0);
    });
});