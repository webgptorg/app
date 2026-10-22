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
import type { TestDeps } from '../../testing/test-deps';
import { createTestDeps } from '../../testing/test-deps';
import type { TunnelTerminationReason } from '../metrics/reason-counters';
import type { ClientAddress, StreamHandlers, TunnelSession, TunnelSessionLimits, TunnelStream } from './tunnel-session';
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

const LIMITS: TunnelSessionLimits = { framesPerS: 1000, minWindowIncrementBytes: 1024 };

const id = (value: number): StreamId => StreamId.parse(value);
const bytes = (length: number, fill = 7): Bytes => new Uint8Array(length).fill(fill);

describe('createTunnelSession', () => {
    let transport: FakeTransport;
    let closedWith: number[];
    let terminated: TunnelTerminationReason[];
    let clock: TestDeps['clock'];
    let session: TunnelSession;

    const create = (firstStreamId?: number, limits: Partial<TunnelSessionLimits> = {}): TunnelSession =>
        createTunnelSession({
            engineId: ENGINE_ID,
            remoteIp: '198.51.100.4',
            protocolVersion: 1,
            features: [],
            transport,
            onClosed: (code) => closedWith.push(code),
            clock,
            limits: { ...LIMITS, ...limits },
            terminations: { count: (reason) => terminated.push(reason) },
            ...(firstStreamId === undefined ? {} : { firstStreamId }),
        });
    const dataSizes = (frames: readonly Frame[]): number[] =>
        frames.map((frame) => (frame.type === FrameType.DATA ? frame.payload.length : 0));
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
        terminated = [];
        clock = createTestDeps().clock;
        session = create();
    });

    it('exposes the negotiated session and the transport buffer', () => {
        expect(session).toMatchObject({ engineId: ENGINE_ID, remoteIp: '198.51.100.4', protocolVersion: 1 });
        transport.setBufferedBytes(42);
        expect(session.bufferedBytes()).toBe(42);
        const woken: string[] = [];
        session.whenBufferedBelow(10, () => woken.push('below 10'));
        const cancel = session.whenBufferedBelow(10, () => woken.push('cancelled'));
        cancel();
        transport.setBufferedBytes(9);
        expect(woken).toEqual(['below 10']);
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
        // One frame for the rest, across the two queued writes.
        expect(dataSizes(tail)).toEqual([60, 45]);
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

    describe('against a hostile engine', () => {
        /** A stream whose window is open by `open` bytes, the rest of the initial window spent. */
        const withOpenWindow = (openBytes: number) => {
            const opened = open();
            opened.stream.write(bytes(INITIAL_WINDOW_BYTES - openBytes));
            transport.frames.length = 0;
            return opened;
        };

        it('collects credit-limited sends until the minimum increment, so 1-byte grants buy no 1-byte frames', () => {
            const { stream, recorded } = withOpenWindow(300);
            expect(stream.write(bytes(5000))).toBe(false);
            expect(sentOfType(FrameType.DATA)).toEqual([]);
            for (let grant = 0; grant < 723; grant++)
                receive({ type: FrameType.WINDOW, streamId: stream.id, increment: 1 });
            expect(sentOfType(FrameType.DATA)).toEqual([]);
            receive({ type: FrameType.WINDOW, streamId: stream.id, increment: 1 });
            expect(dataSizes(sentOfType(FrameType.DATA))).toEqual([1024]);
            // The window is closed now: a grant that reopens it is sent on at once, however small.
            receive({ type: FrameType.WINDOW, streamId: stream.id, increment: 10 });
            expect(dataSizes(sentOfType(FrameType.DATA))).toEqual([1024, 10]);
            receive({ type: FrameType.WINDOW, streamId: stream.id, increment: MAX_FRAME_PAYLOAD_BYTES });
            expect(stream.queuedBytes()).toBe(0);
            expect(recorded.drains).toBe(1);
            expect(dataSizes(sentOfType(FrameType.DATA))).toEqual([1024, 10, 5000 - 1034]);
        });

        it('fills one frame from several queued writes, ending inside one of them', () => {
            const { stream } = withOpenWindow(0);
            stream.write(bytes(10, 1));
            stream.write(bytes(5000, 2));
            receive({ type: FrameType.WINDOW, streamId: stream.id, increment: 1500 });
            const [frame] = sentOfType(FrameType.DATA);
            expect(frame?.type === FrameType.DATA && [...frame.payload.subarray(8, 12)]).toEqual([1, 1, 2, 2]);
            expect(dataSizes(sentOfType(FrameType.DATA))).toEqual([1500]);
            expect(stream.queuedBytes()).toBe(3510);
        });

        it('sends a small frame when it carries everything queued', () => {
            const { stream } = withOpenWindow(300);
            expect(stream.write(bytes(20))).toBe(true);
            expect(dataSizes(sentOfType(FrameType.DATA))).toEqual([20]);
        });

        it('never sends DATA below the minimum increment unless the window was closed', () => {
            const { stream } = withOpenWindow(700);
            stream.write(bytes(100_000));
            let available = 700;
            const small: { readonly size: number; readonly wasClosed: boolean }[] = [];
            for (let grant = 0; grant < 900; grant++) {
                const increment = 1 + (grant % 7) * 150;
                const wasClosed = available === 0;
                const before = transport.frames.length;
                receive({ type: FrameType.WINDOW, streamId: stream.id, increment });
                const sizes = dataSizes(transport.frames.slice(before));
                available += increment - sizes.reduce((total, size) => total + size, 0);
                for (const size of sizes) if (size < 1024) small.push({ size, wasClosed });
            }
            expect(session.isClosed()).toBe(false);
            expect(small.length).toBeGreaterThan(0);
            expect(small.every((frame) => frame.wasClosed)).toBe(true);
        });

        it.each<[string, (stream: TunnelStream) => Uint8Array]>([
            ['ignorable frames', () => Uint8Array.of(0x85, 0, 0, 0, 1, 9)],
            [
                'CLOSE for an old stream',
                () => encodeFrame({ type: FrameType.CLOSE, streamId: id(1), code: CLOSE_CODE.NORMAL }),
            ],
            [
                '1-byte WINDOW grants',
                (stream) => encodeFrame({ type: FrameType.WINDOW, streamId: stream.id, increment: 1 }),
            ],
        ])('closes the tunnel when %s exceed the frame budget', (_, frame) => {
            open().stream.close(CLOSE_CODE.NORMAL);
            const { stream, recorded } = open();
            stream.write(bytes(INITIAL_WINDOW_BYTES + 100_000));
            for (let sent = 0; sent < LIMITS.framesPerS; sent++) session.receive(frame(stream));
            expect(session.isClosed()).toBe(false);
            // The budget refills with time: a second later the same burst is fine again.
            clock.advance(1000);
            for (let sent = 0; sent < LIMITS.framesPerS; sent++) session.receive(frame(stream));
            expect(session.isClosed()).toBe(false);
            session.receive(frame(stream));
            expect(transport.closes).toEqual([{ code: TUNNEL_CLOSE_CODE.FRAME_BUDGET, reason: '' }]);
            expect(closedWith).toEqual([TUNNEL_CLOSE_CODE.FRAME_BUDGET]);
            expect(terminated).toEqual(['frame-budget']);
            expect(recorded.closed).toEqual([CLOSE_CODE.RESET]);
        });
    });
});
