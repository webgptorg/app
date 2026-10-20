import { Duplex } from 'node:stream';

import type { AddressFamily, Bytes, CloseCode, Frame, StreamId } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    FrameType,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    decodeFrame,
    encodeFrame,
} from '@ptbk/protocol';
import type { RawData, WebSocket } from 'ws';

/** One stream as the engine sees it: a Duplex of the browser's raw bytes, with C-02's credit rules kept exactly. */
export interface EngineStream extends Duplex {
    readonly id: StreamId;
    /** The browser address from `OPEN`. */
    readonly client: { readonly family: AddressFamily; readonly address: Bytes; readonly port: number };
    /** The relay's `CLOSE` code, once it arrives. */
    readonly remoteClose: Promise<CloseCode>;
    /** DATA bytes received so far. */
    received(): number;
    /** DATA bytes sent so far. */
    sent(): number;
    /** Credit the relay still grants this side. */
    credit(): number;
    /** Sends `CLOSE` with `code` and forgets the stream. */
    closeWith(code: CloseCode): void;
}

export interface EngineStreams {
    /** The next stream the relay opens. */
    next(): Promise<EngineStream>;
    /** Sees every DATA payload the relay delivers, before it reaches its stream: what crossed the relay. */
    onPayload(listener: (payload: Uint8Array) => void): void;
}

export interface EngineStreamOptions {
    /** How much a stream buffers for a reader that does not read before it stops granting credit. */
    readonly readableHighWaterMark?: number;
}

/**
 * The engine side of a tunnel's streams, built from `@ptbk/protocol` alone: credit is granted back only as the reader
 * consumes, and DATA is sent only within the relay's credit, as a real engine must. Attach after `ready`.
 */
export function serveEngineStreams(ws: WebSocket, options: EngineStreamOptions = {}): EngineStreams {
    const streams = new Map<StreamId, (frame: Frame) => void>();
    const all: EngineStream[] = [];
    const opened: EngineStream[] = [];
    const waiting: ((stream: EngineStream) => void)[] = [];
    const payloadListeners: ((payload: Uint8Array) => void)[] = [];
    const send = (frame: Parameters<typeof encodeFrame>[0]): void => {
        ws.send(encodeFrame(frame));
    };

    function open(id: StreamId, client: EngineStream['client']): EngineStream {
        let credit = INITIAL_WINDOW_BYTES;
        let ungranted = 0;
        let received = 0;
        let sent = 0;
        let closed = false;
        let blocked: { bytes: Uint8Array; callback: (error?: Error | null) => void } | null = null;
        let resolveClose: (code: CloseCode) => void = () => undefined;
        const remoteClose = new Promise<CloseCode>((resolve) => {
            resolveClose = resolve;
        });

        const grant = (): void => {
            if (ungranted === 0 || closed) return;
            send({ type: FrameType.WINDOW, streamId: id, increment: ungranted });
            ungranted = 0;
        };

        const flush = (): void => {
            while (blocked !== null && credit > 0 && !closed) {
                const size = Math.min(blocked.bytes.length, credit, MAX_FRAME_PAYLOAD_BYTES);
                send({ type: FrameType.DATA, streamId: id, payload: blocked.bytes.subarray(0, size) as Bytes });
                credit -= size;
                sent += size;
                if (size === blocked.bytes.length) {
                    const { callback } = blocked;
                    blocked = null;
                    callback();
                } else {
                    blocked = { ...blocked, bytes: blocked.bytes.subarray(size) };
                }
            }
        };

        const forget = (): void => {
            closed = true;
            streams.delete(id);
            blocked?.callback();
            blocked = null;
        };

        const duplex = new Duplex({
            readableHighWaterMark: options.readableHighWaterMark ?? 65_536,
            read: grant,
            write(chunk: Buffer, _encoding, callback) {
                if (closed) {
                    callback();
                    return;
                }
                blocked = { bytes: chunk, callback };
                flush();
            },
            final(callback) {
                if (!closed) {
                    send({ type: FrameType.CLOSE, streamId: id, code: CLOSE_CODE.NORMAL });
                    forget();
                }
                callback();
            },
            destroy(error, callback) {
                if (!closed) {
                    send({ type: FrameType.CLOSE, streamId: id, code: CLOSE_CODE.RESET });
                    forget();
                }
                callback(error);
            },
        });

        streams.set(id, (frame) => {
            switch (frame.type) {
                case FrameType.DATA:
                    received += frame.payload.length;
                    ungranted += frame.payload.length;
                    if (duplex.push(frame.payload)) grant();
                    return;
                case FrameType.WINDOW:
                    credit += frame.increment;
                    flush();
                    return;
                case FrameType.CLOSE:
                    forget();
                    resolveClose(frame.code);
                    duplex.push(null);
                    return;
                case FrameType.OPEN:
                    throw new Error('OPEN for an open stream');
            }
        });

        return Object.assign(duplex, {
            id,
            client,
            remoteClose,
            received: () => received,
            sent: () => sent,
            credit: () => credit,
            closeWith(code: CloseCode) {
                if (closed) return;
                send({ type: FrameType.CLOSE, streamId: id, code });
                forget();
            },
        });
    }

    ws.on('message', (data: RawData, isBinary: boolean) => {
        if (!isBinary) return;
        const decoded = decodeFrame(data as Buffer);
        if (decoded.kind !== 'frame') throw new Error(`relay sent an invalid frame (${decoded.kind})`);
        const { frame } = decoded;
        if (frame.type === FrameType.OPEN) {
            const stream = open(frame.streamId, { family: frame.family, address: frame.address, port: frame.port });
            all.push(stream);
            const wake = waiting.shift();
            if (wake === undefined) opened.push(stream);
            else wake(stream);
            return;
        }
        if (frame.type === FrameType.DATA) for (const listener of payloadListeners) listener(frame.payload);
        streams.get(frame.streamId)?.(frame);
    });
    ws.on('close', () => {
        for (const stream of all) stream.destroy();
    });

    return {
        next() {
            const stream = opened.shift();
            if (stream !== undefined) return Promise.resolve(stream);
            return new Promise((resolve) => waiting.push(resolve));
        },
        onPayload(listener) {
            payloadListeners.push(listener);
        },
    };
}
