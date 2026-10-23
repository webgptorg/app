import { Duplex } from 'node:stream';

import type { Bytes, CloseCode, Frame, OpenFrame, StreamId } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    FrameType,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    createReceiveWindow,
    createSendWindow,
    decodeFrame,
} from '@ptbk/protocol';

/*
 * The engine side of a tunnel's streams, with the mock engine's (M-01) flow control kept exactly: credit goes back to
 * the relay only as the consumer reads, in batches of half a window, and DATA is sent only within the relay's credit,
 * one frame per written chunk. Apps never import apps, so this is a port of mock-engine's stream-mux.ts and
 * tunnel-duplex.ts rather than an import; a generator that granted more eagerly would flatter the relay.
 */

const GRANT_THRESHOLD = INITIAL_WINDOW_BYTES / 2;

export type MuxReceive = { readonly kind: 'ok' } | { readonly kind: 'protocol-error'; readonly reason: string };

export interface EngineMux {
    receive(bytes: Uint8Array): MuxReceive;
    closeAll(): void;
    openStreams(): number;
}

export interface EngineMuxDeps {
    sendFrame(frame: Frame): void;
    /** A browser stream the relay opened, as a Duplex of the browser's raw TLS bytes. */
    onStream(stream: TunnelDuplex, open: OpenFrame): void;
}

const OK: MuxReceive = Object.freeze({ kind: 'ok' });

interface LiveStream {
    readonly duplex: TunnelDuplex;
    data(payload: Bytes): boolean;
    window(increment: number): boolean;
    end(code: CloseCode | null): void;
}

class StreamClosedError extends Error {
    constructor(code: CloseCode | null) {
        super(code === null ? 'tunnel lost' : `stream closed by the relay (${String(code)})`);
        this.name = 'StreamClosedError';
    }
}

interface PendingWrite {
    readonly chunk: Buffer;
    offset: number;
    readonly callback: (error?: Error | null) => void;
}

export interface StreamPort {
    sendCredit(): number;
    send(payload: Bytes): void;
    consumed(bytes: number): void;
    close(code: CloseCode): void;
    isOpen(): boolean;
}

/** One stream as a Duplex, so a TLS server runs over it like over a socket. */
export class TunnelDuplex extends Duplex {
    readonly streamId: StreamId;
    readonly #port: StreamPort;
    #pushed = 0;
    #reported = 0;
    #pending: PendingWrite | undefined;
    #ended = false;

    constructor(streamId: StreamId, port: StreamPort) {
        super({ allowHalfOpen: false });
        this.streamId = streamId;
        this.#port = port;
    }

    deliver(payload: Bytes): void {
        this.#pushed += payload.length;
        this.push(payload);
    }

    creditGranted(): void {
        this.#flush();
    }

    remoteClosed(code: CloseCode | null): void {
        this.#ended = true;
        if (code === CLOSE_CODE.NORMAL) {
            this.#failPending(new StreamClosedError(code));
            this.push(null);
            return;
        }
        this.destroy(new StreamClosedError(code));
    }

    override _read(): void {
        const consumed = this.#pushed - this.readableLength - this.#reported;
        if (consumed <= 0) return;
        this.#reported += consumed;
        this.#port.consumed(consumed);
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.#pending = { chunk, offset: 0, callback };
        this.#flush();
    }

    override _final(callback: (error?: Error | null) => void): void {
        if (this.#port.isOpen()) {
            this.#port.close(CLOSE_CODE.NORMAL);
            this.push(null);
        }
        callback();
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        if (this.#port.isOpen()) this.#port.close(error === null ? CLOSE_CODE.NORMAL : CLOSE_CODE.RESET);
        this.#failPending(error ?? new Error('tunnel stream destroyed'));
        callback(error);
    }

    #flush(): void {
        const pending = this.#pending;
        if (pending === undefined) return;
        if (this.#ended) {
            this.#failPending(new StreamClosedError(null));
            return;
        }
        while (pending.offset < pending.chunk.length) {
            const size = Math.min(
                this.#port.sendCredit(),
                MAX_FRAME_PAYLOAD_BYTES,
                pending.chunk.length - pending.offset,
            );
            if (size === 0) return;
            this.#port.send(new Uint8Array(pending.chunk.subarray(pending.offset, pending.offset + size)));
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

export function createEngineMux(deps: EngineMuxDeps): EngineMux {
    const live = new Map<StreamId, LiveStream>();
    let highestOpened = 0;
    let lost = false;

    function open(frame: OpenFrame): void {
        const { streamId } = frame;
        const sendWindow = createSendWindow(INITIAL_WINDOW_BYTES);
        const receiveWindow = createReceiveWindow(INITIAL_WINDOW_BYTES);
        let isOpen = true;
        let uncredited = 0;
        let pendingGrant = 0;
        const port: StreamPort = {
            isOpen: () => isOpen,
            sendCredit: () => (isOpen ? sendWindow.available() : 0),
            send(payload) {
                if (sendWindow.consume(payload.length).kind === 'violation') throw new RangeError('beyond credit');
                deps.sendFrame({ type: FrameType.DATA, streamId, payload });
            },
            consumed(bytes) {
                if (bytes > uncredited) throw new RangeError('consumed more bytes than were received');
                uncredited -= bytes;
                if (!isOpen) return;
                pendingGrant += bytes;
                if (pendingGrant < GRANT_THRESHOLD) return;
                receiveWindow.grant(pendingGrant);
                deps.sendFrame({ type: FrameType.WINDOW, streamId, increment: pendingGrant });
                pendingGrant = 0;
            },
            close(code) {
                if (!isOpen) return;
                isOpen = false;
                live.delete(streamId);
                deps.sendFrame({ type: FrameType.CLOSE, streamId, code });
            },
        };
        const duplex = new TunnelDuplex(streamId, port);
        live.set(streamId, {
            duplex,
            data(payload) {
                if (receiveWindow.consume(payload.length).kind === 'violation') return false;
                uncredited += payload.length;
                duplex.deliver(payload);
                return true;
            },
            window(increment) {
                if (sendWindow.grant(increment).kind === 'violation') return false;
                duplex.creditGranted();
                return true;
            },
            end(code) {
                isOpen = false;
                live.delete(streamId);
                duplex.remoteClosed(code);
            },
        });
        deps.onStream(duplex, frame);
    }

    function flowControl(streamId: StreamId, stream: LiveStream): MuxReceive {
        deps.sendFrame({ type: FrameType.CLOSE, streamId, code: CLOSE_CODE.FLOW_CONTROL });
        stream.end(CLOSE_CODE.FLOW_CONTROL);
        return { kind: 'protocol-error', reason: 'flow-control' };
    }

    function handle(frame: Frame): MuxReceive {
        if (frame.type === FrameType.OPEN) {
            if (live.has(frame.streamId) || frame.streamId <= highestOpened) {
                return { kind: 'protocol-error', reason: 'stream-id-reused' };
            }
            highestOpened = frame.streamId;
            open(frame);
            return OK;
        }
        const stream = live.get(frame.streamId);
        if (stream === undefined) {
            return frame.streamId > highestOpened ? { kind: 'protocol-error', reason: 'unknown-stream' } : OK;
        }
        switch (frame.type) {
            case FrameType.DATA:
                return stream.data(frame.payload) ? OK : flowControl(frame.streamId, stream);
            case FrameType.WINDOW:
                return stream.window(frame.increment) ? OK : flowControl(frame.streamId, stream);
            case FrameType.CLOSE:
                stream.end(frame.code);
                return OK;
        }
    }

    return {
        receive(bytes) {
            if (lost) return OK;
            const decoded = decodeFrame(bytes);
            switch (decoded.kind) {
                case 'invalid':
                    return { kind: 'protocol-error', reason: decoded.reason };
                case 'ignored':
                    return OK;
                case 'frame':
                    return handle(decoded.frame);
            }
        },
        closeAll() {
            lost = true;
            for (const stream of [...live.values()]) stream.end(null);
        },
        openStreams: () => live.size,
    };
}
