import type { Bytes, CloseCode, Frame, StreamId } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    FrameType,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    MAX_WINDOW_INCREMENT,
    encodeFrame,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { StreamMux } from './stream-mux';
import { createStreamMux, formatRemoteAddress } from './stream-mux';
import type { StreamEnd, TunnelStream } from './tunnel-stream';

interface Recorded {
    readonly stream: TunnelStream;
    readonly data: Bytes[];
    readonly ends: StreamEnd[];
    credits: number;
}

function setup(onOpen?: (stream: TunnelStream) => void) {
    const sent: Frame[] = [];
    const opened: Recorded[] = [];
    const mux: StreamMux = createStreamMux({
        sendFrame: (frame) => sent.push(frame),
        onOpen(stream) {
            const recorded: Recorded = { stream, data: [], ends: [], credits: 0 };
            opened.push(recorded);
            onOpen?.(stream);
            return {
                data: (payload) => recorded.data.push(payload),
                sendCredit: () => {
                    recorded.credits++;
                },
                closed: (end) => recorded.ends.push(end),
            };
        },
    });
    return { mux, sent, opened };
}

const id = (value: number) => value as StreamId;

function open(streamId: number): Uint8Array {
    return encodeFrame({
        type: FrameType.OPEN,
        streamId: id(streamId),
        family: 4,
        address: Uint8Array.of(192, 0, 2, 1),
        port: 443,
    });
}

function data(streamId: number, length: number): Uint8Array {
    return encodeFrame({ type: FrameType.DATA, streamId: id(streamId), payload: new Uint8Array(length).fill(7) });
}

function windowFrame(streamId: number, increment: number): Uint8Array {
    return encodeFrame({ type: FrameType.WINDOW, streamId: id(streamId), increment });
}

function close(streamId: number, code: CloseCode = CLOSE_CODE.NORMAL): Uint8Array {
    return encodeFrame({ type: FrameType.CLOSE, streamId: id(streamId), code });
}

function first(opened: readonly Recorded[]): Recorded {
    const recorded = opened[0];
    if (recorded === undefined) throw new Error('no stream opened');
    return recorded;
}

/** Fills the receive window exactly, in maximum-size frames. */
function fillWindow(mux: StreamMux, streamId: number): void {
    for (let sent = 0; sent < INITIAL_WINDOW_BYTES; sent += MAX_FRAME_PAYLOAD_BYTES) {
        expect(mux.receive(data(streamId, MAX_FRAME_PAYLOAD_BYTES))).toEqual({ kind: 'ok' });
    }
}

describe('formatRemoteAddress', () => {
    const v6 = (...groups: number[]) => {
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        groups.forEach((group, index) => {
            view.setUint16(index * 2, group);
        });
        return formatRemoteAddress({ family: 6, address: bytes, port: 1 }).address;
    };

    it('formats IPv4 as a dotted quad', () => {
        expect(formatRemoteAddress({ family: 4, address: Uint8Array.of(10, 0, 0, 255), port: 8 })).toEqual({
            family: 'IPv4',
            address: '10.0.0.255',
            port: 8,
        });
    });

    it('formats IPv6 per RFC 5952', () => {
        expect(v6(0, 0, 0, 0, 0, 0, 0, 0)).toBe('::');
        expect(v6(0, 0, 0, 0, 0, 0, 0, 1)).toBe('::1');
        expect(v6(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1)).toBe('2001:db8::1');
        expect(v6(0xfe80, 0, 0, 0, 0xabcd, 0, 0, 0)).toBe('fe80::abcd:0:0:0');
        expect(v6(0x2001, 0xdb8, 0, 1, 1, 1, 1, 1)).toBe('2001:db8:0:1:1:1:1:1');
        expect(v6(1, 0, 0, 2, 0, 0, 3, 4)).toBe('1::2:0:0:3:4');
        expect(v6(0x2001, 0, 0, 1, 0, 0, 0, 1)).toBe('2001:0:0:1::1');
        expect(v6(1, 2, 3, 4, 5, 6, 7, 0)).toBe('1:2:3:4:5:6:7:0');
        expect(formatRemoteAddress({ family: 6, address: new Uint8Array(16), port: 9 }).family).toBe('IPv6');
    });
});

describe('createStreamMux', () => {
    it('opens a stream with the client address from OPEN', () => {
        const { mux, opened } = setup();
        expect(mux.receive(open(1))).toEqual({ kind: 'ok' });
        const { stream } = first(opened);
        expect(stream.id).toBe(1);
        expect(stream.remote).toEqual({ family: 'IPv4', address: '192.0.2.1', port: 443 });
        expect(stream.isOpen()).toBe(true);
        expect(stream.sendCredit()).toBe(INITIAL_WINDOW_BYTES);
        expect(mux.openStreams()).toBe(1);
    });

    it('rejects a duplicate OPEN and a reused stream ID', () => {
        const { mux } = setup();
        mux.receive(open(5));
        expect(mux.receive(open(5))).toEqual({ kind: 'protocol-error', reason: 'duplicate-open' });
        expect(mux.receive(open(3))).toEqual({ kind: 'protocol-error', reason: 'stream-id-reused' });
        mux.receive(close(5));
        expect(mux.receive(open(5))).toEqual({ kind: 'protocol-error', reason: 'stream-id-reused' });
        expect(mux.receive(open(6))).toEqual({ kind: 'ok' });
    });

    it('rejects frames for a stream that was never opened', () => {
        const { mux } = setup();
        mux.receive(open(1));
        expect(mux.receive(data(2, 1))).toEqual({ kind: 'protocol-error', reason: 'unknown-stream' });
        expect(mux.receive(windowFrame(2, 1))).toEqual({ kind: 'protocol-error', reason: 'unknown-stream' });
        expect(mux.receive(close(2))).toEqual({ kind: 'protocol-error', reason: 'unknown-stream' });
    });

    it('ignores frames still in flight for a stream already closed', () => {
        const { mux, opened, sent } = setup();
        mux.receive(open(1));
        mux.receive(open(2));
        const [one, two] = opened;
        one?.stream.close(CLOSE_CODE.NORMAL);
        mux.receive(close(2));
        for (const streamId of [1, 2]) {
            expect(mux.receive(data(streamId, 10))).toEqual({ kind: 'ok' });
            expect(mux.receive(windowFrame(streamId, 10))).toEqual({ kind: 'ok' });
            expect(mux.receive(close(streamId))).toEqual({ kind: 'ok' });
        }
        expect(one?.data).toEqual([]);
        expect(two?.ends).toEqual([{ kind: 'remote', code: CLOSE_CODE.NORMAL }]);
        expect(sent).toEqual([{ type: FrameType.CLOSE, streamId: 1, code: CLOSE_CODE.NORMAL }]);
    });

    it('drops unknown ignorable frames and surfaces invalid ones', () => {
        const { mux } = setup();
        expect(mux.receive(Uint8Array.of(0x85, 0, 0, 0, 1, 9))).toEqual({ kind: 'ok' });
        expect(mux.receive(Uint8Array.of(0x05, 0, 0, 0, 1))).toEqual({
            kind: 'protocol-error',
            reason: 'unknown-type',
        });
        expect(mux.receive(Uint8Array.of(1, 0))).toEqual({ kind: 'protocol-error', reason: 'too-short' });
    });

    it('delivers DATA and credits it back in batches of half a window as it is consumed', () => {
        const { mux, opened, sent } = setup();
        mux.receive(open(1));
        const recorded = first(opened);
        fillWindow(mux, 1);
        expect(recorded.data.reduce((total, chunk) => total + chunk.length, 0)).toBe(INITIAL_WINDOW_BYTES);

        recorded.stream.consumed(INITIAL_WINDOW_BYTES / 2 - 1);
        expect(sent).toEqual([]);
        recorded.stream.consumed(1);
        expect(sent).toEqual([{ type: FrameType.WINDOW, streamId: 1, increment: INITIAL_WINDOW_BYTES / 2 }]);

        expect(mux.receive(data(1, INITIAL_WINDOW_BYTES / 4))).toEqual({ kind: 'ok' });
        recorded.stream.consumed(INITIAL_WINDOW_BYTES / 2 + INITIAL_WINDOW_BYTES / 4);
        expect(sent.at(-1)).toEqual({
            type: FrameType.WINDOW,
            streamId: 1,
            increment: INITIAL_WINDOW_BYTES / 2 + INITIAL_WINDOW_BYTES / 4,
        });
    });

    it('refuses to credit bytes that were never received', () => {
        const { mux, opened } = setup();
        mux.receive(open(1));
        const { stream } = first(opened);
        expect(() => {
            stream.consumed(1);
        }).toThrow(RangeError);
        mux.receive(data(1, 10));
        expect(() => {
            stream.consumed(0);
        }).toThrow(RangeError);
        expect(() => {
            stream.consumed(1.5);
        }).toThrow(RangeError);
        expect(() => {
            stream.consumed(11);
        }).toThrow(RangeError);
    });

    it('accepts consumption after a remote close without granting', () => {
        const { mux, opened, sent } = setup();
        mux.receive(open(1));
        fillWindow(mux, 1);
        mux.receive(close(1));
        first(opened).stream.consumed(INITIAL_WINDOW_BYTES);
        expect(sent).toEqual([]);
    });

    it('closes the stream with FLOW_CONTROL and reports a protocol error for DATA beyond credit', () => {
        const { mux, opened, sent } = setup();
        mux.receive(open(1));
        mux.receive(open(2));
        const recorded = first(opened);
        fillWindow(mux, 1);
        expect(mux.receive(data(1, 1))).toEqual({ kind: 'protocol-error', reason: 'flow-control' });
        expect(sent).toEqual([{ type: FrameType.CLOSE, streamId: 1, code: CLOSE_CODE.FLOW_CONTROL }]);
        expect(recorded.ends).toEqual([{ kind: 'flow-control' }]);
        expect(recorded.stream.isOpen()).toBe(false);
        expect(mux.openStreams()).toBe(1);
    });

    it('treats a WINDOW that overflows the send window as a flow-control error', () => {
        const { mux, opened, sent } = setup();
        mux.receive(open(1));
        expect(mux.receive(windowFrame(1, MAX_WINDOW_INCREMENT))).toEqual({
            kind: 'protocol-error',
            reason: 'flow-control',
        });
        expect(sent).toEqual([{ type: FrameType.CLOSE, streamId: 1, code: CLOSE_CODE.FLOW_CONTROL }]);
        expect(first(opened).ends).toEqual([{ kind: 'flow-control' }]);
    });

    it('sends DATA within credit and refuses what the protocol forbids', () => {
        const { mux, opened, sent } = setup();
        mux.receive(open(1));
        const recorded = first(opened);
        const { stream } = recorded;
        expect(() => {
            stream.send(new Uint8Array(0));
        }).toThrow(RangeError);
        expect(() => {
            stream.send(new Uint8Array(MAX_FRAME_PAYLOAD_BYTES + 1));
        }).toThrow(RangeError);
        for (let used = 0; used < INITIAL_WINDOW_BYTES; used += MAX_FRAME_PAYLOAD_BYTES) {
            stream.send(new Uint8Array(MAX_FRAME_PAYLOAD_BYTES));
        }
        expect(sent).toHaveLength(INITIAL_WINDOW_BYTES / MAX_FRAME_PAYLOAD_BYTES);
        expect(sent[0]).toMatchObject({ type: FrameType.DATA, streamId: 1 });
        expect(stream.sendCredit()).toBe(0);
        expect(() => {
            stream.send(new Uint8Array(1));
        }).toThrow(RangeError);

        mux.receive(windowFrame(1, 100));
        expect(recorded.credits).toBe(1);
        expect(stream.sendCredit()).toBe(100);

        stream.close(CLOSE_CODE.NORMAL);
        expect(stream.sendCredit()).toBe(0);
        expect(() => {
            stream.send(new Uint8Array(1));
        }).toThrow(RangeError);
    });

    it('closes a stream once, without telling its consumer', () => {
        const { mux, opened, sent } = setup();
        mux.receive(open(1));
        const recorded = first(opened);
        recorded.stream.close(CLOSE_CODE.RESET);
        recorded.stream.close(CLOSE_CODE.NORMAL);
        expect(sent).toEqual([{ type: FrameType.CLOSE, streamId: 1, code: CLOSE_CODE.RESET }]);
        expect(recorded.ends).toEqual([]);
        expect(mux.openStreams()).toBe(0);
    });

    it('lets the consumer refuse a stream while it opens', () => {
        const { mux, sent } = setup((stream) => {
            stream.close(CLOSE_CODE.REFUSED);
        });
        mux.receive(open(1));
        expect(sent).toEqual([{ type: FrameType.CLOSE, streamId: 1, code: CLOSE_CODE.REFUSED }]);
        expect(mux.openStreams()).toBe(0);
        expect(mux.receive(data(1, 1))).toEqual({ kind: 'ok' });
    });

    it('reports a remote CLOSE with its code', () => {
        const { mux, opened } = setup();
        mux.receive(open(1));
        mux.receive(close(1, CLOSE_CODE.TIMEOUT));
        expect(first(opened).ends).toEqual([{ kind: 'remote', code: CLOSE_CODE.TIMEOUT }]);
        expect(mux.openStreams()).toBe(0);
    });

    it('ends every stream when the tunnel is lost and ignores frames afterwards', () => {
        const { mux, opened, sent } = setup();
        mux.receive(open(1));
        mux.receive(open(2));
        mux.closeAll();
        expect(opened.map((recorded) => recorded.ends)).toEqual([[{ kind: 'tunnel-lost' }], [{ kind: 'tunnel-lost' }]]);
        expect(opened.every((recorded) => !recorded.stream.isOpen())).toBe(true);
        expect(mux.receive(open(3))).toEqual({ kind: 'ok' });
        expect(mux.receive(Uint8Array.of(0))).toEqual({ kind: 'ok' });
        expect(mux.openStreams()).toBe(0);
        first(opened).stream.close(CLOSE_CODE.NORMAL);
        expect(sent).toEqual([]);
    });
});
