import { Duplex } from 'node:stream';

import type { Bytes, CloseCode, StreamId } from '@ptbk/protocol';
import { CLOSE_CODE, MAX_FRAME_PAYLOAD_BYTES } from '@ptbk/protocol';

import type { StreamEnd, StreamEvents, TunnelStream } from '../domain/tunnel/tunnel-stream';

const CLOSE_CODE_NAMES: ReadonlyMap<CloseCode, string> = new Map(
    Object.entries(CLOSE_CODE).map(([name, code]) => [code, name]),
);

function describe(end: StreamEnd): string {
    switch (end.kind) {
        case 'remote':
            return `tunnel stream closed by the relay (${CLOSE_CODE_NAMES.get(end.code) ?? String(end.code)})`;
        case 'flow-control':
            return 'tunnel stream closed: the relay broke flow control';
        case 'tunnel-lost':
            return 'tunnel stream closed: the tunnel was lost';
    }
}

export class TunnelStreamError extends Error {
    readonly end: StreamEnd;

    constructor(end: StreamEnd) {
        super(describe(end));
        this.name = 'TunnelStreamError';
        this.end = end;
    }
}

interface PendingWrite {
    readonly chunk: Buffer;
    offset: number;
    readonly callback: (error?: Error | null) => void;
}

/**
 * One tunnel stream as a Node `Duplex`, so a TLS server can run over it like over a socket. Writes wait for the
 * relay's `WINDOW` credit; received bytes are credited back only as the consumer reads them, so a slow reader stalls
 * the relay instead of growing our buffer past one window.
 *
 * `CLOSE` is a full close (C-02 defines no half-close): ending the writable side closes the stream, and TLS
 * `close_notify` carries the orderly shutdown above it.
 */
export class TunnelDuplex extends Duplex {
    readonly streamId: StreamId;
    readonly remoteAddress: string;
    readonly remotePort: number;
    readonly remoteFamily: 'IPv4' | 'IPv6';
    /** Hand these to the mux; they drive the duplex. */
    readonly events: StreamEvents;
    readonly #stream: TunnelStream;
    #pushed = 0;
    #reported = 0;
    #pending: PendingWrite | undefined;
    #end: StreamEnd | undefined;

    constructor(stream: TunnelStream) {
        super({ allowHalfOpen: false });
        this.#stream = stream;
        this.streamId = stream.id;
        this.remoteAddress = stream.remote.address;
        this.remotePort = stream.remote.port;
        this.remoteFamily = stream.remote.family;
        this.events = {
            data: (payload) => {
                this.#pushed += payload.length;
                this.push(payload);
            },
            sendCredit: () => {
                this.#flush();
            },
            closed: (end) => {
                this.#closed(end);
            },
        };
    }

    override _read(): void {
        const consumed = this.#pushed - this.readableLength - this.#reported;
        if (consumed <= 0) return;
        this.#reported += consumed;
        this.#stream.consumed(consumed);
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.#pending = { chunk, offset: 0, callback };
        this.#flush();
    }

    override _final(callback: (error?: Error | null) => void): void {
        if (this.#stream.isOpen()) {
            this.#stream.close(CLOSE_CODE.NORMAL);
            this.push(null);
        }
        callback();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        if (this.#stream.isOpen()) this.#stream.close(error === null ? CLOSE_CODE.NORMAL : CLOSE_CODE.RESET);
        this.#failPending(error ?? new Error('tunnel stream destroyed'));
        callback(error);
    }

    #closed(end: StreamEnd): void {
        this.#end = end;
        if (end.kind === 'remote' && end.code === CLOSE_CODE.NORMAL) {
            this.#failPending(new TunnelStreamError(end));
            this.push(null);
            return;
        }
        this.destroy(new TunnelStreamError(end));
    }

    #flush(): void {
        const pending = this.#pending;
        if (pending === undefined) return;
        if (this.#end !== undefined) {
            this.#failPending(new TunnelStreamError(this.#end));
            return;
        }
        while (pending.offset < pending.chunk.length) {
            const size = Math.min(
                this.#stream.sendCredit(),
                MAX_FRAME_PAYLOAD_BYTES,
                pending.chunk.length - pending.offset,
            );
            if (size === 0) return;
            const payload: Bytes = new Uint8Array(pending.chunk.subarray(pending.offset, pending.offset + size));
            this.#stream.send(payload);
            pending.offset += size;
        }
        this.#pending = undefined;
        pending.callback();
    }

    #failPending(error: Error): void {
        const pending = this.#pending;
        this.#pending = undefined;
        pending?.callback(error);
    }
}

export function openTunnelDuplex(stream: TunnelStream): TunnelDuplex {
    return new TunnelDuplex(stream);
}
