import type { Bytes, CloseCode, Frame, FrameInvalidReason, OpenFrame, StreamId } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    FrameType,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    createReceiveWindow,
    createSendWindow,
    decodeFrame,
} from '@ptbk/protocol';

import type { RemoteAddress, StreamEnd, StreamEvents, TunnelStream } from './tunnel-stream';

export interface StreamMuxDeps {
    sendFrame(frame: Frame): void;
    /** Returns the consumer's events; the consumer may close the stream right away (e.g. REFUSED). */
    onOpen(stream: TunnelStream): StreamEvents;
}

export type MuxProtocolError =
    FrameInvalidReason | 'duplicate-open' | 'stream-id-reused' | 'unknown-stream' | 'flow-control';

export type MuxReceive =
    { readonly kind: 'ok' } | { readonly kind: 'protocol-error'; readonly reason: MuxProtocolError };

/** The engine side of one tunnel's streams. A `protocol-error` means the caller must close the whole tunnel. */
export interface StreamMux {
    receive(bytes: Uint8Array): MuxReceive;
    /** The tunnel is gone: every live stream ends with `tunnel-lost`, and the mux ignores everything after. */
    closeAll(): void;
    openStreams(): number;
}

/**
 * Credit is returned in batches of half a window. This cannot deadlock: unless bytes sit unread in the consumer's
 * buffer (the slow-consumer case, where stalling the relay is the point), less than half a window is held back, so
 * the relay always has credit left to send.
 */
const GRANT_THRESHOLD = INITIAL_WINDOW_BYTES / 2;

const OK: MuxReceive = Object.freeze({ kind: 'ok' });

function protocolError(reason: MuxProtocolError): MuxReceive {
    return { kind: 'protocol-error', reason };
}

interface LiveStream {
    /** `false` when the frame breaks flow control; the stream is left untouched for the mux to close. */
    data(payload: Bytes): boolean;
    window(increment: number): boolean;
    end(end: StreamEnd): void;
}

function formatIpv6(bytes: Bytes): string {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const groups = Array.from({ length: 8 }, (_, index) => view.getUint16(index * 2));
    // RFC 5952: compress the longest run of two or more zero groups, the first one on a tie.
    let bestStart = -1;
    let bestLength = 1;
    for (let start = 0; start < groups.length;) {
        let end = start;
        while (end < groups.length && groups[end] === 0) end++;
        if (end - start > bestLength) {
            bestStart = start;
            bestLength = end - start;
        }
        start = Math.max(end, start + 1);
    }
    const hex = groups.map((group) => group.toString(16));
    if (bestStart < 0) return hex.join(':');
    return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

export function formatRemoteAddress(frame: Pick<OpenFrame, 'family' | 'address' | 'port'>): RemoteAddress {
    return frame.family === 4
        ? { family: 'IPv4', address: Array.from(frame.address).join('.'), port: frame.port }
        : { family: 'IPv6', address: formatIpv6(frame.address), port: frame.port };
}

export function createStreamMux(deps: StreamMuxDeps): StreamMux {
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

        const stream: TunnelStream = {
            id: streamId,
            remote: formatRemoteAddress(frame),
            isOpen: () => isOpen,
            sendCredit: () => (isOpen ? sendWindow.available() : 0),
            send(payload) {
                if (!isOpen) throw new RangeError('stream is closed');
                if (payload.length < 1 || payload.length > MAX_FRAME_PAYLOAD_BYTES) {
                    throw new RangeError('DATA payload must be 1..MAX_FRAME_PAYLOAD_BYTES bytes');
                }
                if (sendWindow.consume(payload.length).kind === 'violation') {
                    throw new RangeError('DATA payload exceeds the send credit');
                }
                deps.sendFrame({ type: FrameType.DATA, streamId, payload });
            },
            consumed(bytes) {
                if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > uncredited) {
                    throw new RangeError('consumed more bytes than were received');
                }
                uncredited -= bytes;
                if (!isOpen) return;
                pendingGrant += bytes;
                if (pendingGrant < GRANT_THRESHOLD) return;
                // Cannot overflow: the window plus what is pending never exceeds INITIAL_WINDOW_BYTES.
                receiveWindow.grant(pendingGrant);
                deps.sendFrame({ type: FrameType.WINDOW, streamId, increment: pendingGrant });
                pendingGrant = 0;
            },
            close(code: CloseCode) {
                if (!isOpen) return;
                isOpen = false;
                live.delete(streamId);
                deps.sendFrame({ type: FrameType.CLOSE, streamId, code });
            },
        };

        const events = deps.onOpen(stream);
        if (!stream.isOpen()) return;
        live.set(streamId, {
            data(payload) {
                if (receiveWindow.consume(payload.length).kind === 'violation') return false;
                uncredited += payload.length;
                events.data(payload);
                return true;
            },
            window(increment) {
                if (sendWindow.grant(increment).kind === 'violation') return false;
                events.sendCredit();
                return true;
            },
            end(end) {
                isOpen = false;
                live.delete(streamId);
                events.closed(end);
            },
        });
    }

    function flowControl(streamId: StreamId, stream: LiveStream): MuxReceive {
        deps.sendFrame({ type: FrameType.CLOSE, streamId, code: CLOSE_CODE.FLOW_CONTROL });
        stream.end({ kind: 'flow-control' });
        return protocolError('flow-control');
    }

    function handle(frame: Frame): MuxReceive {
        if (frame.type === FrameType.OPEN) {
            if (live.has(frame.streamId)) return protocolError('duplicate-open');
            if (frame.streamId <= highestOpened) return protocolError('stream-id-reused');
            highestOpened = frame.streamId;
            open(frame);
            return OK;
        }
        const stream = live.get(frame.streamId);
        if (stream === undefined) {
            // A frame for a stream we already closed was in flight when we closed it; one never opened is an error.
            return frame.streamId > highestOpened ? protocolError('unknown-stream') : OK;
        }
        switch (frame.type) {
            case FrameType.DATA:
                return stream.data(frame.payload) ? OK : flowControl(frame.streamId, stream);
            case FrameType.WINDOW:
                return stream.window(frame.increment) ? OK : flowControl(frame.streamId, stream);
            case FrameType.CLOSE:
                stream.end({ kind: 'remote', code: frame.code });
                return OK;
        }
    }

    return {
        receive(bytes) {
            if (lost) return OK;
            const decoded = decodeFrame(bytes);
            switch (decoded.kind) {
                case 'invalid':
                    return protocolError(decoded.reason);
                case 'ignored':
                    return OK;
                case 'frame':
                    return handle(decoded.frame);
            }
        },
        closeAll() {
            lost = true;
            for (const stream of [...live.values()]) stream.end({ kind: 'tunnel-lost' });
        },
        openStreams: () => live.size,
    };
}
