import type { Bytes, CloseCode, EngineId, Frame } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    EngineId as EngineIdSchema,
    FrameType,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    MAX_WINDOW_BYTES,
    StreamId,
    TUNNEL_CLOSE_CODE,
    encodeFrame,
} from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { FakeTransport } from '../../testing/fake-transport';
import { createFakeTransport } from '../../testing/fake-transport';
import type { ClientAddress, StreamHandlers, TunnelSession, TunnelStream } from './tunnel-session';
import { MAX_STREAM_ID, createTunnelSession } from './tunnel-session';

const ENGINE_ID: EngineId = EngineIdSchema.parse('a'.repeat(26));
const IPV4: ClientAddress = { family: 4, address: Uint8Array.of(192, 0, 2, 7), port: 51_000 };
const IPV6: ClientAddress = {
    family: 6,
    address: Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, ...new Array<number>(11).fill(0), 1),
    port: 443,
};

interface Recorded {
    readonly handlers: StreamHandlers;
    readonly data: Bytes[];
    readonly closed: CloseCode[];
    drains: number;
}

function recorder(): Recorded {
    const recorded: Recorded = {
        data: [],
        closed: [],
        drains: 0,
        handlers: {
            data: (bytes) => recorded.data.push(bytes),
            drain: () => {
                recorded.drains++;
            },
            closed: (code) => recorded.closed.push(code),
        },
    };
    return recorded;
}

const id = (value: number): StreamId => StreamId.parse(value);
const bytes = (length: number, fill = 7): Bytes => new Uint8Array(length).fill(fill);

describe('createTunnelSession', () => {
    let transport: FakeTransport;
    let closedWith: number[];
    let session: TunnelSession;

    const create = (firstStreamId?: number): TunnelSession =>
        createTunnelSession({
            engineId: ENGINE_ID,
            remoteIp: '198.51.100.4',
            protocolVersion: 1,
            features: [],
            transport,
            onClosed: (code) => closedWith.push(code),
            ...(firstStreamId === undefined ? {} : { firstStreamId }),
        });
    const receive = (frame: Frame): void => {
        session.receive(encodeFrame(frame));
    };
    const open = (client: ClientAddress = IPV4): { stream: TunnelStream; recorded: Recorded } => {
        const recorded = recorder();
        const stream = session.openStream(client, recorded.handlers);
        if (stream === null) throw new Error('expected a stream');
        return { stream, recorded };
    };
    const sentOfType = (type: number): Frame[] => transport.frames.filter((frame) => frame.type === type);
    const expectProtocolError = (): void => {
        expect(transport.closes).toEqual([{ code: TUNNEL_CLOSE_CODE.PROTOCOL_ERROR, reason: '' }]);
        expect(closedWith).toEqual([TUNNEL_CLOSE_CODE.PROTOCOL_ERROR]);
        expect(session.isClosed()).toBe(true);
    };

    beforeEach(() => {
        transport = createFakeTransport();
        closedWith = [];
        session = create();
    });

    it('exposes the negotiated session and the transport buffer', () => {
        expect(session).toMatchObject({ engineId: ENGINE_ID, remoteIp: '198.51.100.4', protocolVersion: 1 });
        transport.setBufferedBytes(42);
        expect(session.bufferedBytes()).toBe(42);
    });

    it('opens streams with increasing IDs from 1 and sends OPEN with the client address', () => {
        const first = open(IPV4).stream;
        const second = open(IPV6).stream;
        first.close(CLOSE_CODE.NORMAL);
        const third = open().stream;
        expect([first.id, second.id, third.id]).toEqual([1, 2, 3]);
        expect(sentOfType(FrameType.OPEN)).toEqual([
            { type: FrameType.OPEN, streamId: 1, ...IPV4 },
            { type: FrameType.OPEN, streamId: 2, ...IPV6 },
            { type: FrameType.OPEN, streamId: 3, ...IPV4 },
        ]);
        expect(session.activeStreams()).toBe(2);
    });

    it('throws on a malformed client address without taking a stream ID', () => {
        expect(() => session.openStream({ family: 4, address: bytes(16), port: 1 }, recorder().handlers)).toThrow(
            RangeError,
        );
        expect(open().stream.id).toBe(1);
        expect(session.activeStreams()).toBe(1);
    });

    it('closes with SHUTTING_DOWN instead of reusing an ID once stream IDs run out', () => {
        session = create(MAX_STREAM_ID);
        expect(open().stream.id).toBe(MAX_STREAM_ID);
        expect(session.openStream(IPV4, recorder().handlers)).toBeNull();
        expect(transport.closes).toEqual([{ code: TUNNEL_CLOSE_CODE.SHUTTING_DOWN, reason: '' }]);
        expect(closedWith).toEqual([TUNNEL_CLOSE_CODE.SHUTTING_DOWN]);
    });

    it('delivers DATA and returns credit with WINDOW as it is consumed', () => {
        const { stream, recorded } = open();
        receive({ type: FrameType.DATA, streamId: stream.id, payload: Uint8Array.of(1, 2, 3) });
        expect(recorded.data).toEqual([Uint8Array.of(1, 2, 3)]);
        stream.consumed(2);
        stream.consumed(1);
        expect(sentOfType(FrameType.WINDOW)).toEqual([
            { type: FrameType.WINDOW, streamId: stream.id, increment: 2 },
            { type: FrameType.WINDOW, streamId: stream.id, increment: 1 },
        ]);
        expect(() => {
            stream.consumed(1);
        }).toThrow(RangeError);
        expect(() => {
            stream.consumed(0);
        }).toThrow(RangeError);
    });

    it('accepts DATA up to the granted credit and closes the session one byte beyond it', () => {
        const { stream, recorded } = open();
        for (let sent = 0; sent < INITIAL_WINDOW_BYTES; sent += MAX_FRAME_PAYLOAD_BYTES) {
            receive({ type: FrameType.DATA, streamId: stream.id, payload: bytes(MAX_FRAME_PAYLOAD_BYTES) });
        }
        expect(session.isClosed()).toBe(false);
        receive({ type: FrameType.DATA, streamId: stream.id, payload: Uint8Array.of(1) });
        expect(sentOfType(FrameType.CLOSE)).toEqual([
            { type: FrameType.CLOSE, streamId: stream.id, code: CLOSE_CODE.FLOW_CONTROL },
        ]);
        expect(recorded.closed).toEqual([CLOSE_CODE.FLOW_CONTROL]);
        expectProtocolError();
    });

    it('allows more DATA once credit was returned', () => {
        const { stream } = open();
        for (let sent = 0; sent < INITIAL_WINDOW_BYTES; sent += MAX_FRAME_PAYLOAD_BYTES) {
            receive({ type: FrameType.DATA, streamId: stream.id, payload: bytes(MAX_FRAME_PAYLOAD_BYTES) });
        }
        stream.consumed(10);
        receive({ type: FrameType.DATA, streamId: stream.id, payload: bytes(10) });
        expect(session.isClosed()).toBe(false);
    });

    it('splits writes into frames, queues beyond credit and releases the queue on WINDOW', () => {
        const { stream, recorded } = open();
        expect(stream.write(bytes(INITIAL_WINDOW_BYTES + 100))).toBe(false);
        const data = sentOfType(FrameType.DATA);
        expect(data.map((frame) => (frame.type === FrameType.DATA ? frame.payload.length : 0))).toEqual(
            new Array<number>(INITIAL_WINDOW_BYTES / MAX_FRAME_PAYLOAD_BYTES).fill(MAX_FRAME_PAYLOAD_BYTES),
        );
        expect(stream.queuedBytes()).toBe(100);
        expect(stream.write(bytes(5))).toBe(false);
        receive({ type: FrameType.WINDOW, streamId: stream.id, increment: 60 });
        expect(stream.queuedBytes()).toBe(45);
        expect(recorded.drains).toBe(0);
        receive({ type: FrameType.WINDOW, streamId: stream.id, increment: 1000 });
        expect(stream.queuedBytes()).toBe(0);
        expect(recorded.drains).toBe(1);
        const tail = sentOfType(FrameType.DATA).slice(data.length);
        expect(tail.map((frame) => (frame.type === FrameType.DATA ? frame.payload.length : 0))).toEqual([60, 40, 5]);
        receive({ type: FrameType.WINDOW, streamId: stream.id, increment: 10 });
        expect(recorded.drains).toBe(1);
        expect(stream.write(new Uint8Array(0))).toBe(true);
        expect(stream.write(bytes(3))).toBe(true);
    });

    it('treats a WINDOW grant past the maximum window as a flow-control violation', () => {
        const { stream, recorded } = open();
        receive({ type: FrameType.WINDOW, streamId: stream.id, increment: MAX_WINDOW_BYTES });
        expect(recorded.closed).toEqual([CLOSE_CODE.FLOW_CONTROL]);
        expectProtocolError();
    });

    it('forgets a stream the engine closed', () => {
        const { stream, recorded } = open();
        receive({ type: FrameType.CLOSE, streamId: stream.id, code: CLOSE_CODE.RESET });
        expect(recorded.closed).toEqual([CLOSE_CODE.RESET]);
        expect(session.activeStreams()).toBe(0);
        expect(stream.write(bytes(1))).toBe(false);
        stream.close(CLOSE_CODE.NORMAL);
        expect(sentOfType(FrameType.CLOSE)).toEqual([]);
    });

    it('drops frames still in flight for a stream this side closed', () => {
        const { stream, recorded } = open();
        stream.close(CLOSE_CODE.NORMAL);
        receive({ type: FrameType.DATA, streamId: stream.id, payload: Uint8Array.of(1) });
        receive({ type: FrameType.WINDOW, streamId: stream.id, increment: 1 });
        receive({ type: FrameType.CLOSE, streamId: stream.id, code: CLOSE_CODE.NORMAL });
        expect(recorded.data).toEqual([]);
        expect(session.isClosed()).toBe(false);
    });

    it.each<[string, Frame]>([
        ['CLOSE for a stream never opened', { type: FrameType.CLOSE, streamId: id(1), code: CLOSE_CODE.NORMAL }],
        ['DATA for a stream never opened', { type: FrameType.DATA, streamId: id(5), payload: Uint8Array.of(1) }],
        ['WINDOW for a stream never opened', { type: FrameType.WINDOW, streamId: id(9), increment: 1 }],
        ['OPEN from the engine', { type: FrameType.OPEN, streamId: id(1), ...IPV4 }],
    ])('closes the session with PROTOCOL_ERROR on %s', (_, frame) => {
        receive(frame);
        expectProtocolError();
    });

    it('closes the session with PROTOCOL_ERROR on an undecodable frame', () => {
        session.receive(Uint8Array.of(2, 0, 0));
        expectProtocolError();
    });

    it('drops an unknown frame type marked ignorable', () => {
        session.receive(Uint8Array.of(0x85, 0, 0, 0, 1, 9));
        expect(session.isClosed()).toBe(false);
    });

    it('closes once, resetting open streams, and ignores everything afterwards', () => {
        const first = open();
        const second = open();
        session.close(TUNNEL_CLOSE_CODE.REPLACED);
        session.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
        session.transportClosed(1006);
        expect(transport.closes).toEqual([{ code: TUNNEL_CLOSE_CODE.REPLACED, reason: '' }]);
        expect(closedWith).toEqual([TUNNEL_CLOSE_CODE.REPLACED]);
        expect(first.recorded.closed).toEqual([CLOSE_CODE.RESET]);
        expect(second.recorded.closed).toEqual([CLOSE_CODE.RESET]);
        expect(session.openStream(IPV4, recorder().handlers)).toBeNull();
        const framesBefore = transport.frames.length;
        session.receive(encodeFrame({ type: FrameType.OPEN, streamId: id(1), ...IPV4 }));
        expect(first.stream.write(bytes(1))).toBe(false);
        first.stream.close(CLOSE_CODE.NORMAL);
        expect(transport.frames).toHaveLength(framesBefore);
    });

    it('reports a transport that closed underneath it once, with its code', () => {
        const { stream, recorded } = open();
        receive({ type: FrameType.DATA, streamId: stream.id, payload: Uint8Array.of(1) });
        session.transportClosed(1006);
        session.transportClosed(1000);
        expect(closedWith).toEqual([1006]);
        expect(transport.closes).toEqual([]);
        expect(recorded.closed).toEqual([CLOSE_CODE.RESET]);
        stream.consumed(1);
        expect(sentOfType(FrameType.WINDOW)).toEqual([]);
    });
});
