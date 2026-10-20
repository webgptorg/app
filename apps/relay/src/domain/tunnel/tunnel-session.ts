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

/** The largest stream ID (u32); the session closes rather than wrap around (C-02: IDs are never reused). */
export const MAX_STREAM_ID = 0xffff_ffff;

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
 * credit), since an engine that breaks the protocol cannot be trusted with the streams it still holds.
 */
export function createTunnelSession(options: TunnelSessionOptions): TunnelSession {
    const { engineId, remoteIp, protocolVersion, features, transport, onClosed } = options;
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

    function flush(id: StreamId, stream: StreamState): void {
        while (stream.queue.length > 0 && stream.send.available() > 0) {
            const chunk = stream.queue[0] as Uint8Array;
            const size = Math.min(chunk.length, stream.send.available(), MAX_FRAME_PAYLOAD_BYTES);
            stream.send.consume(size);
            sendFrame({ type: FrameType.DATA, streamId: id, payload: chunk.subarray(0, size) as Bytes });
            stream.queued -= size;
            if (size === chunk.length) stream.queue.shift();
            else stream.queue[0] = chunk.subarray(size);
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
                if (stream.send.grant(frame.increment).kind === 'violation') {
                    violateFlowControl(id, stream);
                    return;
                }
                const blocked = stream.queued > 0;
                flush(id, stream);
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
                    flush(id, stream);
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
