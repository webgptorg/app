import type { Bytes, CloseCode, StreamId } from '@ptbk/protocol';

/** The browser's address from `OPEN`, in the shape `net.Socket` uses. */
export interface RemoteAddress {
    readonly family: 'IPv4' | 'IPv6';
    /** Dotted quad, or RFC 5952 text for IPv6. */
    readonly address: string;
    readonly port: number;
}

export type StreamEnd =
    /** The relay sent `CLOSE` with this code. */
    | { readonly kind: 'remote'; readonly code: CloseCode }
    /** The relay broke flow control on this stream; the mux sent `CLOSE FLOW_CONTROL` and the tunnel is closing. */
    | { readonly kind: 'flow-control' }
    /** The tunnel closed under the stream. */
    | { readonly kind: 'tunnel-lost' };

/** What the consumer of a stream (the duplex adapter) hears from the mux. */
export interface StreamEvents {
    data(payload: Bytes): void;
    /** The relay granted send credit (`WINDOW`). */
    sendCredit(): void;
    /** The stream is gone; called at most once and never after the consumer's own `close`. */
    closed(end: StreamEnd): void;
}

/** One stream of a tunnel, as the mux hands it to its consumer. */
export interface TunnelStream {
    readonly id: StreamId;
    readonly remote: RemoteAddress;
    /** False once either side closed the stream. */
    isOpen(): boolean;
    /** Bytes `send` may take now; 0 means wait for `sendCredit`. */
    sendCredit(): number;
    /**
     * Sends one `DATA` frame. Throws a RangeError for an empty payload, one above `MAX_FRAME_PAYLOAD_BYTES` or the
     * credit, or a closed stream: those are bugs in the consumer.
     */
    send(payload: Bytes): void;
    /** The consumer delivered `bytes` received bytes downstream; credit flows back to the relay as `WINDOW`. */
    consumed(bytes: number): void;
    /** Sends `CLOSE` with `code` and forgets the stream; idempotent. */
    close(code: CloseCode): void;
}
