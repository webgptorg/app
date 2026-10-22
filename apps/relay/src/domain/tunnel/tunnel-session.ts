import type {
    AddressFamily,
    Bytes,
    CloseCode,
    EngineId,
    FlowWindow,
    Frame,
    StreamId,
    TunnelCloseCode,
    TunnelFeature,
} from '@ptbk/protocol';
import {
    CLOSE_CODE,
    FrameType,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    TUNNEL_CLOSE_CODE,
    createReceiveWindow,
    createSendWindow,
    decodeFrame,
    encodeFrame,
} from '@ptbk/protocol';

import type { Clock } from '../clock';
import { createTokenBucket } from '../limits/token-bucket';
import type { ReasonCounters, TunnelTerminationReason } from '../metrics/reason-counters';

/** The largest stream ID (u32); the session closes rather than wrap around (C-02: IDs are never reused). */
export const MAX_STREAM_ID = 0xffff_ffff;

/**
 * C-02 has no close code for exceeding a relay policy, and `PROTOCOL_ERROR` is what every other abuse of the frame
 * layer gets; a dedicated code would be an addition to C-02 (ADR 0010).
 */
export const FRAME_BUDGET_CLOSE_CODE = TUNNEL_CLOSE_CODE.PROTOCOL_ERROR;

export interface TunnelSessionLimits {
    /** `RELAY_TUNNEL_FRAMES_PER_S`: frames from the engine per second, of any kind; also the burst. */
    readonly framesPerS: number;
    /**
     * `RELAY_TUNNEL_MIN_WINDOW_INCREMENT_BYTES`: credit the relay collects before it sends DATA, unless the window was
     * fully closed or the frame carries everything queued.
     */
    readonly minWindowIncrementBytes: number;
}

/** One authenticated WebSocket, binary messages only. */
export interface TunnelTransport {
    /** Queues one binary message; `false` when the transport is already closed and the frame was dropped. */
    send(frame: Uint8Array): boolean;
    close(code: number, reason: string): void;
    /** Bytes queued in the transport and not yet written to the socket. */
    bufferedBytes(): number;
    /**
     * Calls `callback` once, after a write leaves fewer than `bytes` queued; the result cancels it. Only meaningful
     * while `bufferedBytes()` is at least `bytes`; never called once the transport is closed.
     */
    whenBufferedBelow(bytes: number, callback: () => void): () => void;
}

/** The browser's address as the relay saw it; the engine gets it in `OPEN` to rate-limit and audit. */
export interface ClientAddress {
    readonly family: AddressFamily;
    readonly address: Bytes;
    readonly port: number;
}

export interface StreamHandlers {
    /** DATA from the engine. Call `consumed` once the bytes are delivered downstream, so the engine may send more. */
    data(bytes: Bytes): void;
    /** Everything `write` queued has been sent; called only after `write` returned `false`. */
    drain(): void;
    /** The stream is gone: the engine's `CLOSE` code, `FLOW_CONTROL` after a violation, `RESET` when the session ends. */
    closed(code: CloseCode): void;
}

export interface TunnelStream {
    readonly id: StreamId;
    /**
     * Sends `bytes` as DATA within the engine's credit and queues the rest until `WINDOW` grants more. `false` means
     * bytes are queued: stop writing until `drain`. `bytes` must not be modified afterwards.
     */
    write(bytes: Uint8Array): boolean;
    /** Returns credit for `bytes` delivered downstream (at most what `data` handed out and was not yet returned). */
    consumed(bytes: number): void;
    /** Sends `CLOSE` and forgets the stream; `closed` is not called. */
    close(code: CloseCode): void;
    queuedBytes(): number;
}

export interface TunnelSessionOptions {
    readonly engineId: EngineId;
    readonly remoteIp: string;
    readonly protocolVersion: number;
    readonly features: readonly TunnelFeature[];
    readonly transport: TunnelTransport;
    /** Called once, with the code this side sent or the transport reported. */
    readonly onClosed: (code: number) => void;
    readonly clock: Clock;
    readonly limits: TunnelSessionLimits;
    readonly terminations: Pick<ReasonCounters<TunnelTerminationReason>, 'count'>;
    /** Where stream IDs start; only tests move it, to reach `MAX_STREAM_ID`. */
    readonly firstStreamId?: number;
}

export interface TunnelSession {
    readonly engineId: EngineId;
    readonly remoteIp: string;
    /** Negotiated in the handshake; additive fields are sent only for features both sides announced. */
    readonly protocolVersion: number;
    readonly features: readonly TunnelFeature[];
    /** `null` when the session is closed or out of stream IDs (it then closes with `SHUTTING_DOWN`). */
    openStream(client: ClientAddress, handlers: StreamHandlers): TunnelStream | null;
    /** One binary message from the engine. */
    receive(message: Uint8Array): void;
    close(code: TunnelCloseCode): void;
    /** The transport closed underneath the session. */
    transportClosed(code: number): void;
    isClosed(): boolean;
    activeStreams(): number;
    bufferedBytes(): number;
    /** The transport's `whenBufferedBelow`, so R-04's scheduler can wait for the WebSocket to drain. */
    whenBufferedBelow(bytes: number, callback: () => void): () => void;
}

interface StreamState {
    readonly handlers: StreamHandlers;
    readonly send: FlowWindow;
    readonly receive: FlowWindow;
    readonly queue: Uint8Array[];
    queued: number;
    /** Delivered by `data` and not yet returned through `consumed`. */
    outstanding: number;
}

/**
 * The relay's side of one tunnel: it alone opens streams, tracks each direction's credit, and closes the whole session
 * on any protocol violation by the engine (an invalid frame, `OPEN`, a frame for a stream never opened, data beyond
 * credit), since an engine that breaks the protocol cannot be trusted with the streams it still holds. Every frame
 * from the engine, even one that is ignored, spends the tunnel's frame budget, so frames that cost the relay work but
 * break no rule (ignorable types, `CLOSE` for old streams, tiny `WINDOW` grants) cannot be sent without limit.
 */
export function createTunnelSession(options: TunnelSessionOptions): TunnelSession {
    const { engineId, remoteIp, protocolVersion, features, transport, onClosed, clock, limits, terminations } = options;
    const { framesPerS, minWindowIncrementBytes } = limits;
    const frameBudget = createTokenBucket({ capacity: framesPerS, refillPerSecond: framesPerS, clock });
    const streams = new Map<StreamId, StreamState>();
    let nextStreamId = options.firstStreamId ?? 1;
    let closed = false;

    function sendFrame(frame: Frame): void {
        transport.send(encodeFrame(frame));
    }

    function finish(code: number): void {
        closed = true;
        const ended = [...streams.values()];
        streams.clear();
        for (const stream of ended) stream.handlers.closed(CLOSE_CODE.RESET);
        onClosed(code);
    }

    function close(code: TunnelCloseCode): void {
        if (closed) return;
        transport.close(code, '');
        finish(code);
    }

    /** Takes `size` bytes off the front of the queue, copying only when they span chunks. */
    function take(stream: StreamState, size: number): Bytes {
        const head = stream.queue[0] as Uint8Array;
        let payload: Uint8Array;
        if (head.length >= size) {
            payload = head.subarray(0, size);
            if (head.length === size) stream.queue.shift();
            else stream.queue[0] = head.subarray(size);
        } else {
            payload = new Uint8Array(size);
            for (let filled = 0; filled < size;) {
                const chunk = stream.queue[0] as Uint8Array;
                const part = Math.min(chunk.length, size - filled);
                payload.set(chunk.subarray(0, part), filled);
                filled += part;
                if (part === chunk.length) stream.queue.shift();
                else stream.queue[0] = chunk.subarray(part);
            }
        }
        stream.queued -= size;
        return payload as Bytes;
    }

    /** Sends queued bytes as DATA; a frame smaller than `minFrameBytes` goes only if it empties the queue. */
    function flush(id: StreamId, stream: StreamState, minFrameBytes: number): void {
        for (;;) {
            const size = Math.min(stream.queued, stream.send.available(), MAX_FRAME_PAYLOAD_BYTES);
            if (size === 0 || (size < minFrameBytes && size < stream.queued)) return;
            stream.send.consume(size);
            sendFrame({ type: FrameType.DATA, streamId: id, payload: take(stream, size) });
        }
    }

    function violateFlowControl(id: StreamId, stream: StreamState): void {
        sendFrame({ type: FrameType.CLOSE, streamId: id, code: CLOSE_CODE.FLOW_CONTROL });
        streams.delete(id);
        stream.handlers.closed(CLOSE_CODE.FLOW_CONTROL);
        close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
    }

    function dispatch(frame: Frame): void {
        if (frame.type === FrameType.OPEN) {
            close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            return;
        }
        const id = frame.streamId;
        const stream = streams.get(id);
        if (stream === undefined) {
            // Below `nextStreamId` the stream existed and this side closed it; frames sent before the engine saw
            // that `CLOSE` are dropped. Anything else names a stream that never existed.
            if (id >= nextStreamId) close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            return;
        }
        switch (frame.type) {
            case FrameType.DATA:
                if (stream.receive.consume(frame.payload.length).kind === 'violation') {
                    violateFlowControl(id, stream);
                    return;
                }
                stream.outstanding += frame.payload.length;
                stream.handlers.data(frame.payload);
                return;
            case FrameType.CLOSE:
                streams.delete(id);
                stream.handlers.closed(frame.code);
                return;
            case FrameType.WINDOW: {
                // A grant that reopens a closed window is sent on at once, so a peer that grants exactly what it
                // consumed never stalls; smaller grants into an open window are coalesced first.
                const wasClosed = stream.send.available() === 0;
                if (stream.send.grant(frame.increment).kind === 'violation') {
                    violateFlowControl(id, stream);
                    return;
                }
                const blocked = stream.queued > 0;
                flush(id, stream, wasClosed ? 1 : minWindowIncrementBytes);
                if (blocked && stream.queued === 0) stream.handlers.drain();
                return;
            }
        }
    }

    function createStream(id: StreamId, stream: StreamState): TunnelStream {
        return {
            id,
            write(bytes) {
                if (closed || streams.get(id) !== stream) return false;
                if (bytes.length > 0) {
                    stream.queue.push(bytes);
                    stream.queued += bytes.length;
                    flush(id, stream, minWindowIncrementBytes);
                }
                return stream.queued === 0;
            },
            consumed(bytes) {
                if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > stream.outstanding) {
                    throw new RangeError('consumed more bytes than the stream delivered');
                }
                stream.outstanding -= bytes;
                if (closed || streams.get(id) !== stream) return;
                stream.receive.grant(bytes);
                sendFrame({ type: FrameType.WINDOW, streamId: id, increment: bytes });
            },
            close(code) {
                if (closed || streams.get(id) !== stream) return;
                streams.delete(id);
                sendFrame({ type: FrameType.CLOSE, streamId: id, code });
            },
            queuedBytes: () => stream.queued,
        };
    }

    return {
        engineId,
        remoteIp,
        protocolVersion,
        features,
        openStream(client, handlers) {
            if (closed) return null;
            if (nextStreamId > MAX_STREAM_ID) {
                close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
                return null;
            }
            const id = nextStreamId as StreamId;
            // Encoded first: a malformed address throws here, before the stream or its ID is taken.
            const open = encodeFrame({ type: FrameType.OPEN, streamId: id, ...client });
            nextStreamId++;
            const stream: StreamState = {
                handlers,
                send: createSendWindow(INITIAL_WINDOW_BYTES),
                receive: createReceiveWindow(INITIAL_WINDOW_BYTES),
                queue: [],
                queued: 0,
                outstanding: 0,
            };
            streams.set(id, stream);
            transport.send(open);
            return createStream(id, stream);
        },
        receive(message) {
            if (closed) return;
            if (!frameBudget.tryTake(1)) {
                terminations.count('frame-budget');
                close(FRAME_BUDGET_CLOSE_CODE);
                return;
            }
            const decoded = decodeFrame(message);
            switch (decoded.kind) {
                case 'frame':
                    dispatch(decoded.frame);
                    return;
                case 'ignored':
                    return;
                case 'invalid':
                    close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
                    return;
            }
        },
        close,
        transportClosed(code) {
            if (!closed) finish(code);
        },
        isClosed: () => closed,
        activeStreams: () => streams.size,
        bufferedBytes: () => transport.bufferedBytes(),
        whenBufferedBelow: (bytes, callback) => transport.whenBufferedBelow(bytes, callback),
    };
}
