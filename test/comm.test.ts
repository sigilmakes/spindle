import { describe, it, expect, afterEach } from "vitest";
import { CommServer } from "../src/comm/server.js";
import { CommClient } from "../src/comm/client.js";
import { encode, FrameDecoder } from "../src/comm/framing.js";
import type { CommMessage } from "../src/comm/types.js";

// Track resources for cleanup
const servers: CommServer[] = [];
const clients: CommClient[] = [];

afterEach(async () => {
    for (const c of clients) c.disconnect();
    clients.length = 0;
    for (const s of servers) await s.stop();
    servers.length = 0;
});

function trackServer(s: CommServer) { servers.push(s); return s; }
function trackClient(c: CommClient) { clients.push(c); return c; }

describe("framing", () => {
    it("encodes and decodes a message", () => {
        const msg: CommMessage = { type: "send", from: 0, to: 1, msg: "hello" };
        const decoder = new FrameDecoder();
        const result = decoder.push(encode(msg));
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(msg);
    });

    it("handles multiple frames in one chunk", () => {
        const msgs: CommMessage[] = [
            { type: "send", from: 0, to: 1, msg: "a" },
            { type: "broadcast", from: 1, msg: "b" },
        ];
        const decoder = new FrameDecoder();
        const combined = Buffer.concat(msgs.map(encode));
        const result = decoder.push(combined);
        expect(result).toHaveLength(2);
        expect(result[0].msg).toBe("a");
        expect(result[1].msg).toBe("b");
    });

    it("handles partial reads", () => {
        const msg: CommMessage = { type: "send", from: 0, to: 1, msg: "partial" };
        const frame = encode(msg);
        const decoder = new FrameDecoder();

        expect(decoder.push(frame.subarray(0, 3))).toHaveLength(0);
        expect(decoder.push(frame.subarray(3))).toHaveLength(1);
    });

    it("rejects oversized messages", () => {
        const decoder = new FrameDecoder();
        const frame = Buffer.alloc(4);
        frame.writeUInt32BE(999_999_999, 0);
        expect(() => decoder.push(frame)).toThrow("too large");
    });

    it("rejects invalid JSON", () => {
        const decoder = new FrameDecoder();
        const bad = Buffer.from("not json", "utf-8");
        const frame = Buffer.alloc(4 + bad.length);
        frame.writeUInt32BE(bad.length, 0);
        bad.copy(frame, 4);
        expect(() => decoder.push(frame)).toThrow("Invalid JSON");
    });

    it("rejects valid JSON with bad shape", () => {
        const decoder = new FrameDecoder();
        const json = Buffer.from(JSON.stringify({ foo: "bar" }), "utf-8");
        const frame = Buffer.alloc(4 + json.length);
        frame.writeUInt32BE(json.length, 0);
        json.copy(frame, 4);
        expect(() => decoder.push(frame)).toThrow("Invalid comm message");
    });
});

describe("CommServer + CommClient", () => {
    it("starts and provides a socket path", async () => {
        const server = trackServer(new CommServer());
        const sockPath = await server.start();
        expect(sockPath).toContain("spindle-comm-");
        expect(sockPath).toContain("comm.sock");
    });

    it("clients can connect and announce", async () => {
        const server = trackServer(new CommServer());
        await server.start();

        const c0 = trackClient(new CommClient(0));
        const c1 = trackClient(new CommClient(1));
        await c0.connect(server.path!);
        await c1.connect(server.path!);

        expect(c0.connected).toBe(true);
        expect(c1.connected).toBe(true);
    });

    it("point-to-point send delivers to correct rank", async () => {
        const server = trackServer(new CommServer());
        await server.start();

        const c0 = trackClient(new CommClient(0));
        const c1 = trackClient(new CommClient(1));
        await c0.connect(server.path!);
        await c1.connect(server.path!);

        c0.send(1, "hello from 0", { x: 42 });
        const msg = await c1.recv();

        expect(msg.from).toBe(0);
        expect(msg.msg).toBe("hello from 0");
        expect(msg.data).toEqual({ x: 42 });
    });

    it("send does not deliver to sender", async () => {
        const server = trackServer(new CommServer());
        await server.start();

        const c0 = trackClient(new CommClient(0));
        const c1 = trackClient(new CommClient(1));
        await c0.connect(server.path!);
        await c1.connect(server.path!);

        c0.send(1, "for rank 1 only");

        // c0 should not receive its own message
        const msg = await c1.recv();
        expect(msg.msg).toBe("for rank 1 only");

        // Give c0 time to NOT receive anything
        await new Promise(r => setTimeout(r, 50));
    });

    it("broadcast delivers to all except sender", async () => {
        const server = trackServer(new CommServer());
        await server.start();

        const c0 = trackClient(new CommClient(0));
        const c1 = trackClient(new CommClient(1));
        const c2 = trackClient(new CommClient(2));
        await c0.connect(server.path!);
        await c1.connect(server.path!);
        await c2.connect(server.path!);
        await new Promise(r => setTimeout(r, 20)); // let server process announces

        c0.broadcast("hey everyone");

        const m1 = await c1.recv();
        const m2 = await c2.recv();
        expect(m1.from).toBe(0);
        expect(m1.msg).toBe("hey everyone");
        expect(m2.from).toBe(0);
        expect(m2.msg).toBe("hey everyone");
    });

    it("recv with from filter waits for matching sender", async () => {
        const server = trackServer(new CommServer());
        await server.start();

        const c0 = trackClient(new CommClient(0));
        const c1 = trackClient(new CommClient(1));
        const c2 = trackClient(new CommClient(2));
        await c0.connect(server.path!);
        await c1.connect(server.path!);
        await c2.connect(server.path!);

        // c0 wants to hear from c2 specifically
        const recvPromise = c0.recv(2);

        // c1 sends first — should NOT match
        c1.send(0, "from rank 1");
        await new Promise(r => setTimeout(r, 30));

        // c2 sends — should match
        c2.send(0, "from rank 2");
        const msg = await recvPromise;

        expect(msg.from).toBe(2);
        expect(msg.msg).toBe("from rank 2");

        // c1's message should still be in inbox
        const queued = await c0.recv(1);
        expect(queued.msg).toBe("from rank 1");
    });

    it("queues messages for ranks not yet connected", async () => {
        const server = trackServer(new CommServer());
        await server.start();

        const c0 = trackClient(new CommClient(0));
        await c0.connect(server.path!);

        // Send to rank 1 before it connects
        c0.send(1, "early message");

        // Now rank 1 connects
        const c1 = trackClient(new CommClient(1));
        await c1.connect(server.path!);

        // Should receive the queued message
        const msg = await c1.recv();
        expect(msg.msg).toBe("early message");
    });

    it("cleans up on stop", async () => {
        const server = new CommServer();
        const sockPath = await server.start();

        const c0 = new CommClient(0);
        await c0.connect(sockPath);

        await server.stop();
        await new Promise(r => setTimeout(r, 20)); // let close event propagate
        expect(c0.connected).toBe(false);
    });

    it("handles rapid send/recv", async () => {
        const server = trackServer(new CommServer());
        await server.start();

        const c0 = trackClient(new CommClient(0));
        const c1 = trackClient(new CommClient(1));
        await c0.connect(server.path!);
        await c1.connect(server.path!);

        for (let i = 0; i < 20; i++) {
            c0.send(1, `msg-${i}`);
        }

        for (let i = 0; i < 20; i++) {
            const msg = await c1.recv();
            expect(msg.msg).toBe(`msg-${i}`);
        }
    });
});
