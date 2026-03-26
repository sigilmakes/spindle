import * as net from "node:net";
import type { CommMessage } from "./types.js";
import { encode, FrameDecoder } from "./framing.js";

export interface ReceivedMessage {
    from: number;
    msg: string;
    data?: unknown;
}

export class CommClient {
    private socket: net.Socket | null = null;
    private decoder = new FrameDecoder();
    private rank: number;
    private inbox: ReceivedMessage[] = [];
    private waiters: Array<{ from?: number; resolve: (msg: ReceivedMessage) => void }> = [];
    private barrierWaiters = new Map<string, Array<() => void>>();

    constructor(rank: number) {
        this.rank = rank;
    }

    async connect(socketPath: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const socket = net.connect(socketPath);

            socket.on("connect", () => {
                this.socket = socket;
                // Unref so this socket doesn't prevent the process from exiting
                // when the agent loop finishes. The comm tools will still work
                // while the agent is active — unref only matters when the event
                // loop has nothing else keeping it alive.
                socket.unref();
                socket.write(encode({ type: "announce", from: this.rank }));
                resolve();
            });

            socket.on("data", (chunk: Buffer) => {
                let messages: CommMessage[];
                try { messages = this.decoder.push(chunk); }
                catch {
                    this.disconnect();
                    return;
                }
                for (const msg of messages) this.handleIncoming(msg);
            });

            socket.on("error", (err) => {
                if (!this.socket) reject(err);
            });

            socket.on("close", () => {
                this.socket = null;
                this.decoder.reset();
            });
        });
    }

    disconnect(): void {
        if (this.socket && !this.socket.destroyed) this.socket.destroy();
        this.socket = null;
        this.decoder.reset();
        // Reject any pending waiters
        for (const waiter of this.waiters) {
            waiter.resolve({ from: -1, msg: "[disconnected]" });
        }
        this.waiters = [];
        // Release any pending barrier waiters
        for (const waiters of this.barrierWaiters.values()) {
            for (const resolve of waiters) resolve();
        }
        this.barrierWaiters.clear();
    }

    send(to: number, msg: string, data?: unknown): void {
        this.write({ type: "send", from: this.rank, to, msg, data });
    }

    broadcast(msg: string, data?: unknown): void {
        this.write({ type: "broadcast", from: this.rank, msg, data });
    }

    recv(from?: number): Promise<ReceivedMessage> {
        const idx = this.inbox.findIndex(m => from === undefined || m.from === from);
        if (idx !== -1) {
            return Promise.resolve(this.inbox.splice(idx, 1)[0]);
        }
        return new Promise(resolve => {
            this.waiters.push({ from, resolve });
        });
    }

    /**
     * Block until all threads reach this barrier. All threads must call
     * barrier() with the same name for any of them to proceed.
     *
     * @param name Optional barrier name. Defaults to "default". Use distinct
     *   names for multiple synchronization points.
     */
    barrier(name: string = "default", count?: number): Promise<void> {
        this.write({ type: "barrier", from: this.rank, barrierName: name, barrierCount: count });
        return new Promise(resolve => {
            const waiters = this.barrierWaiters.get(name) || [];
            waiters.push(resolve);
            this.barrierWaiters.set(name, waiters);
        });
    }

    get connected(): boolean {
        return this.socket !== null && !this.socket.destroyed;
    }

    private handleIncoming(msg: CommMessage): void {
        if (msg.type === "barrier_release") {
            const name = msg.barrierName ?? "default";
            const waiters = this.barrierWaiters.get(name);
            if (waiters) {
                for (const resolve of waiters) resolve();
                this.barrierWaiters.delete(name);
            }
            return;
        }

        if (msg.type !== "send" && msg.type !== "broadcast") return;

        const received: ReceivedMessage = {
            from: msg.from,
            msg: msg.msg || "",
            data: msg.data,
        };

        const idx = this.waiters.findIndex(w => w.from === undefined || w.from === received.from);
        if (idx !== -1) {
            const waiter = this.waiters.splice(idx, 1)[0];
            waiter.resolve(received);
        } else {
            this.inbox.push(received);
        }
    }

    private write(msg: CommMessage): void {
        if (!this.socket || this.socket.destroyed) {
            throw new Error("Not connected");
        }
        this.socket.write(encode(msg));
    }
}
