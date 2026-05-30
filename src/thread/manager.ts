import * as fs from "node:fs";
import * as path from "node:path";
import type { ThreadAgentExecutor, ThreadExecutionInput, ThreadExecutionResult, ThreadRun } from "./types.js";
import { ThreadRuntime } from "./runtime.js";
import { discoverThreads, resolveThread } from "./library.js";

export interface ThreadManagerOptions {
    cwd: string;
    agentExecutor: ThreadAgentExecutor;
    onUpdate?: (run: ThreadRun) => void;
}

export class ThreadManager {
    private cwd: string;
    private readonly agentExecutor: ThreadAgentExecutor;
    private readonly onUpdate?: (run: ThreadRun) => void;
    private readonly runs = new Map<string, ThreadRun>();
    private readonly cache = new Map<string, unknown>();

    constructor(opts: ThreadManagerOptions) {
        this.cwd = opts.cwd;
        this.agentExecutor = opts.agentExecutor;
        this.onUpdate = opts.onUpdate;
    }

    setCwd(cwd: string): void {
        this.cwd = cwd;
    }

    list(): ThreadRun[] {
        return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
    }

    get(idOrPrefix: string): ThreadRun | undefined {
        return this.list().find((run) => run.id === idOrPrefix || run.id.startsWith(idOrPrefix) || run.name === idOrPrefix);
    }

    discover() {
        return discoverThreads(this.cwd);
    }

    async run(
        input: Omit<ThreadExecutionInput, "cwd"> & { cwd?: string },
        onRunUpdate?: (run: ThreadRun) => void,
    ): Promise<ThreadExecutionResult> {
        const cwd = input.cwd ?? this.cwd;
        let script = input.script;
        let scriptPath = input.scriptPath;

        if (!script && input.name) {
            const resolved = await resolveThread(cwd, input.name);
            script = resolved.script;
            scriptPath = resolved.scriptPath;
        } else if (!script && scriptPath) {
            scriptPath = path.resolve(cwd, scriptPath);
            script = fs.readFileSync(scriptPath, "utf-8");
        }

        const runtime = new ThreadRuntime({
            cwd,
            script,
            scriptPath,
            args: input.args,
            agentExecutor: this.agentExecutor,
            cache: this.cache,
            resolveThreadScript: (nameOrPath) => resolveThread(cwd, nameOrPath),
            onUpdate: (run) => {
                this.runs.set(run.id, run);
                this.onUpdate?.(run);
                onRunUpdate?.(run);
            },
        });
        const result = await runtime.execute();
        this.runs.set(result.run.id, result.run);
        this.onUpdate?.(result.run);
        return result;
    }
}

export function summarizeRun(run: ThreadRun): string {
    const done = run.phases.flatMap((p) => p.agents).filter((a) => a.status === "done" || a.status === "cached").length;
    const total = run.phases.flatMap((p) => p.agents).length;
    const cost = run.usage.cost ? `$${run.usage.cost.toFixed(4)}` : "$0.0000";
    const elapsed = ((run.completedAt ?? Date.now()) - run.startedAt) / 1000;
    return `${run.status} · ${done}/${total} agents · ${cost} · ${elapsed.toFixed(1)}s`;
}
