import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_FRAME_PAYLOAD_BYTES } from './constants';
import { CLOSE_CODE, FrameType, MAX_WINDOW_INCREMENT, StreamId, decodeFrame, encodeFrame } from './frame';
import type { Frame, FrameDecode } from './frame';

const streamId = fc.integer({ min: 1, max: 0xffff_ffff }).map((id) => StreamId.parse(id));
const bytes = (minLength: number, maxLength: number) =>
    fc.uint8Array({ minLength, maxLength }).map((array) => Uint8Array.from(array));

const openFrame: fc.Arbitrary<Frame> = fc.oneof(
    fc.record({
        type: fc.constant(FrameType.OPEN),
        streamId,
        family: fc.constant(4 as const),
        address: bytes(4, 4),
        port: fc.integer({ min: 0, max: 0xffff }),
    }),
    fc.record({
        type: fc.constant(FrameType.OPEN),
        streamId,
        family: fc.constant(6 as const),
        address: bytes(16, 16),
        port: fc.integer({ min: 0, max: 0xffff }),
    }),
);

const dataFrame: fc.Arbitrary<Frame> = fc.record({
    type: fc.constant(FrameType.DATA),
    streamId,
    payload: fc.oneof(bytes(1, 64), bytes(1, MAX_FRAME_PAYLOAD_BYTES)),
});

const closeFrame: fc.Arbitrary<Frame> = fc.record({
    type: fc.constant(FrameType.CLOSE),
    streamId,
    code: fc.constantFrom(...Object.values(CLOSE_CODE)),
});

const windowFrame: fc.Arbitrary<Frame> = fc.record({
    type: fc.constant(FrameType.WINDOW),
    streamId,
    increment: fc.integer({ min: 1, max: MAX_WINDOW_INCREMENT }),
});

const frame = fc.oneof(openFrame, dataFrame, closeFrame, windowFrame);

const REASONS = new Set([
    'too-short',
    'unknown-type',
    'bad-flags',
    'stream-id-zero',
    'payload-too-large',
    'empty-data',
    'bad-open-payload',
    'bad-close-code',
    'bad-window-increment',
    'trailing-bytes',
]);

function expectWellFormed(result: FrameDecode): void {
    switch (result.kind) {
        case 'frame':
            expect(Object.values(FrameType)).toContain(result.frame.type);
            break;
        case 'ignored':
            expect(result.typeCode).toBeGreaterThan(FrameType.WINDOW);
            expect(result.typeCode).toBeLessThanOrEqual(0x7f);
            break;
        case 'invalid':
            expect(REASONS.has(result.reason)).toBe(true);
            break;
    }
}

describe('frame codec properties', () => {
    it('decodeFrame(encodeFrame(f)) equals f', () => {
        fc.assert(
            fc.property(frame, (f) => {
                expect(decodeFrame(encodeFrame(f))).toEqual({ kind: 'frame', frame: f });
            }),
            { numRuns: 500 },
        );
    });

    it('never throws on arbitrary bytes up to 128 KiB', () => {
        fc.assert(
            fc.property(fc.oneof(bytes(0, 64), bytes(0, 128 * 1024)), (input) => {
                expectWellFormed(decodeFrame(input));
            }),
            { numRuns: 300 },
        );
    });

    it('never throws on mutations of valid frames', () => {
        fc.assert(
            fc.property(frame, fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 }))), (f, edits) => {
                const encoded = encodeFrame(f);
                for (const [at, value] of edits) encoded[at % encoded.length] = value;
                expectWellFormed(decodeFrame(encoded));
            }),
            { numRuns: 500 },
        );
    });

    it('rejects every frame whose payload exceeds MAX_FRAME_PAYLOAD_BYTES, whatever its header', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 0, max: 255 }),
                fc.integer({ min: 0, max: 0xffff_ffff }),
                fc.integer({ min: 1, max: 64 }),
                (type, id, extra) => {
                    const input = new Uint8Array(5 + MAX_FRAME_PAYLOAD_BYTES + extra);
                    new DataView(input.buffer).setUint8(0, type);
                    new DataView(input.buffer).setUint32(1, id);
                    expect(decodeFrame(input)).toEqual({ kind: 'invalid', reason: 'payload-too-large' });
                },
            ),
            { numRuns: 50 },
        );
    });

    // One frame per WebSocket message, so the message length is the frame length: a DATA frame cut by a byte is a
    // shorter DATA frame (decided 2026-10-20); everything else becomes invalid.
    it('cutting the last byte off a header, OPEN, CLOSE, WINDOW or 1-byte DATA frame gives invalid', () => {
        const fixedLength = fc.oneof(
            openFrame,
            closeFrame,
            windowFrame,
            fc.record({ type: fc.constant(FrameType.DATA), streamId, payload: bytes(1, 1) }),
        );
        fc.assert(
            fc.property(fixedLength, (f) => {
                const encoded = encodeFrame(f);
                expect(decodeFrame(encoded.subarray(0, encoded.length - 1)).kind).toBe('invalid');
                for (let length = 0; length < 5; length++) {
                    expect(decodeFrame(encoded.subarray(0, length))).toEqual({ kind: 'invalid', reason: 'too-short' });
                }
            }),
            { numRuns: 300 },
        );
    });

    it('cutting the last byte off a DATA frame with 2 or more payload bytes gives the shorter DATA frame', () => {
        fc.assert(
            fc.property(streamId, bytes(2, 512), (id, payload) => {
                const encoded = encodeFrame({ type: FrameType.DATA, streamId: id, payload });
                expect(decodeFrame(encoded.subarray(0, encoded.length - 1))).toEqual({
                    kind: 'frame',
                    frame: { type: FrameType.DATA, streamId: id, payload: payload.slice(0, -1) },
                });
            }),
            { numRuns: 200 },
        );
    });
});
