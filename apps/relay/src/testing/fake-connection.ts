import type { TunnelConnection } from '../domain/tunnel/tunnel-endpoint';

export interface FakeConnection extends TunnelConnection {
    /** Text messages the endpoint sent, in order. */
    readonly texts: string[];
    /** Binary frames the endpoint sent, in order. */
    readonly frames: Uint8Array[];
    /** Close codes the endpoint asked for, in order. */
    readonly closes: number[];
    /** Text messages parsed as JSON. */
    messages(): unknown[];
}

/** An upgraded WebSocket that records what the endpoint does with it. `send` fails once it was closed. */
export function createFakeConnection(): FakeConnection {
    const texts: string[] = [];
    const frames: Uint8Array[] = [];
    const closes: number[] = [];
    return {
        texts,
        frames,
        closes,
        messages: () => texts.map((text) => JSON.parse(text) as unknown),
        sendText(text) {
            texts.push(text);
        },
        transport: {
            send(frame) {
                if (closes.length > 0) return false;
                frames.push(frame);
                return true;
            },
            close(code) {
                closes.push(code);
            },
            bufferedBytes: () => 0,
        },
    };
}
