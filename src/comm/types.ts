export interface CommMessage {
    type: "announce" | "send" | "broadcast" | "barrier" | "barrier_release";
    from: number;
    to?: number;
    msg?: string;
    data?: unknown;
    barrierName?: string;
}
