import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { CommMessage } from "./types.js";
import { encode, FrameDecoder } from "./framing.js";

const MAX_QUEUE_PER_RANK = 1000;

interface RankedClient {
    rank: number;
    socket: net.Socket;
    decoder: FrameDecoder;
}

export class CommServer {
    private server: net.Server | null = null;
    private dir: string | null = null;
    private socketPath: string | null = null;
    private clients = new Map<number, RankedClient>();
    private pendingSockets = new Set<net.Socket>();
    private queued = new Map<number, Buffer[]>();

    async start(): Promise<string> {
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-comm-"));
        this.socketPath = path.join(this.dir, "comm.sock");

        // Clean stale socket if present
        if (fs.existsSync(this.socketPath)) {
            try { fs.unlinkSync(this.socketPath); } catch {}
        }

        return new Promise<string>((resolve, reject) => {
            const server = net.createServer(socket => this.handleConnection(socket));
            server.once("error", reject);
            server.listen(this.socketPath!, () => {
                server.removeListener("error", reject);
                server.on("error", () => {}); // suppress post-listen errors
                this.server = server;
                resolve(this.socketPath!);
            });
        });
    }

    async stop(): Promise<void> {
        for (const socket of this.pendingSockets) socket.destroy();
        this.pendingSockets.clear();

        for (const client of this.clients.values()) client.socket.destroy();
        this.clients.clear();
        this.queued.clear();

        if (this.server) {
            await new Promise<void>(resolve => this.server!.close(() => resolve()));
            this.server = null;
        }

        if (this.socketPath) {
            try { fs.unlinkSync(this.socketPath); } catch {}
        }
        if (this.dir) {
            try { fs.rmdirSync(this.dir); } catch {}
        }
    }

    get path(): string | null {
        return this.socketPath;
    }

    private handleConnection(socket: net.Socket): void {
        const decoder = new FrameDecoder();
        this.pendingSockets.add(socket);

        socket.on("data", (chunk: Buffer) => {
            let messages: CommMessage[];
            try { messages = decoder.push(chunk); }
            catch { socket.destroy(); return; }

            for (const msg of messages) {
                if (msg.type === "announce") {
                    this.pendingSockets.delete(socket);
                    const client: RankedClient = { rank: msg.from, socket, decoder };
                    this.clients.set(msg.from, client);
                    this.flushQueued(msg.from, socket);
                } else {
                    this.route(msg);
                }
            }
        });

        socket.on("close", () => {
            this.pendingSockets.delete(socket);
            for (const [rank, client] of this.clients) {
                if (client.socket === socket) {
                    this.clients.delete(rank);
                    break;
                }
            }
        });

        socket.on("error", (err) => {
            // Suppress ECONNRESET — client disconnected abruptly
            if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
                // silently ignore other errors too — server must stay up
            }
            socket.destroy();
        });
    }

    private route(msg: CommMessage): void {
        if (msg.type === "send" && msg.to !== undefined) {
            this.sendTo(msg.to, msg);
        } else if (msg.type === "broadcast") {
            const frame = encode(msg);
            for (const [rank, client] of this.clients) {
                if (rank !== msg.from) {
                    this.writeSafe(client.socket, frame);
                }
            }
        }
    }

    private sendTo(rank: number, msg: CommMessage): void {
        const client = this.clients.get(rank);
        if (client) {
            this.writeSafe(client.socket, encode(msg));
        } else {
            const q = this.queued.get(rank) || [];
            if (q.length < MAX_QUEUE_PER_RANK) {
                q.push(encode(msg));
                this.queued.set(rank, q);
            }
        }
    }

    private flushQueued(rank: number, socket: net.Socket): void {
        const q = this.queued.get(rank);
        if (!q) return;
        for (const frame of q) this.writeSafe(socket, frame);
        this.queued.delete(rank);
    }

    private writeSafe(socket: net.Socket, frame: Buffer): void {
        try {
            if (!socket.destroyed) socket.write(frame);
        } catch {
            // broken pipe — client gone, will be cleaned up on close event
        }
    }
}
