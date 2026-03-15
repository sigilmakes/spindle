export interface CommMessage {
    type: "announce" | "send" | "broadcast";
    from: number;
    to?: number;
    msg?: string;
    data?: unknown;
}
