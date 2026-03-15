import type { CommMessage } from "./types.js";

const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;
const VALID_TYPES = new Set(["announce", "send", "broadcast"]);

function isValidCommMessage(value: unknown): value is CommMessage {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    if (typeof obj.type !== "string" || !VALID_TYPES.has(obj.type)) return false;
    if (typeof obj.from !== "number") return false;
    return true;
}

export function encode(msg: CommMessage): Buffer {
    const json = Buffer.from(JSON.stringify(msg), "utf-8");
    const frame = Buffer.alloc(4 + json.length);
    frame.writeUInt32BE(json.length, 0);
    json.copy(frame, 4);
    return frame;
}

export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): CommMessage[] {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const messages: CommMessage[] = [];

        while (this.buffer.length >= 4) {
            const len = this.buffer.readUInt32BE(0);
            if (len > MAX_MESSAGE_SIZE) {
                this.buffer = Buffer.alloc(0);
                throw new Error(`Message too large: ${len} bytes (max ${MAX_MESSAGE_SIZE})`);
            }
            if (this.buffer.length < 4 + len) break;

            const json = this.buffer.subarray(4, 4 + len).toString("utf-8");
            this.buffer = this.buffer.subarray(4 + len);

            let parsed: unknown;
            try { parsed = JSON.parse(json); }
            catch {
                this.buffer = Buffer.alloc(0);
                throw new Error(`Invalid JSON in frame: ${json.slice(0, 100)}`);
            }

            if (!isValidCommMessage(parsed)) {
                this.buffer = Buffer.alloc(0);
                throw new Error(`Invalid comm message: ${JSON.stringify(parsed).slice(0, 200)}`);
            }

            messages.push(parsed);
        }

        return messages;
    }

    reset(): void {
        this.buffer = Buffer.alloc(0);
    }
}
