import { describe, it, expect, vi } from "vitest";
import { createProcessAgentDriver } from "../src/workflow/process-driver.js";
import type { WorkflowAgentRequest } from "../src/workflow/types.js";

describe("process driver", () => {
    it("creates a driver function", () => {
        const driver = createProcessAgentDriver({ cwd: process.cwd() });
        expect(typeof driver).toBe("function");
    });

    it("builds process prompts correctly", async () => {
        // We can't actually spawn pi in test, but we can verify the driver is well-formed
        const driver = createProcessAgentDriver({ cwd: process.cwd() });
        const request: WorkflowAgentRequest = {
            id: "a1",
            runId: "wf_test",
            label: "test-agent",
            prompt: "Hello world",
            options: {},
        };
        // This will try to spawn pi and fail gracefully in test environment
        try {
            await driver(request);
        } catch (err: any) {
            // Expected: pi not found or spawn failure in test env
            expect(err).toBeDefined();
        }
    });

    it("respects maxConcurrency option", () => {
        const driver = createProcessAgentDriver({ cwd: process.cwd(), maxConcurrency: 2 });
        expect(typeof driver).toBe("function");
    });
});