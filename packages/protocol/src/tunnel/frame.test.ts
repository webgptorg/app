import { describe, expect, it } from 'vitest';
import type { Bytes } from '../bytes';
import { fromHex, toHex } from '../testing/hex';
import { MAX_FRAME_PAYLOAD_BYTES } from './constants';
import { CLOSE_CODE, FRAME_IGNORABLE_FLAG, FrameType, StreamId, decodeFrame, encodeFrame } from './frame';
import type { CloseCode, Frame, FrameInvalidReason } from './frame';

const stream = (id: number): StreamId => StreamId.parse(id);

function raw(type: number, streamId: number, payload: readonly number[] | Uint8Array = []): Bytes {
    const bytes = new Uint8Array(5 + payload.length);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, type);
    view.setUint32(1, streamId);
    bytes.set(payload, 5);
    return bytes;
}

function expectInvalid(bytes: Uint8Array, reason: FrameInvalidReason): void {
    expect(decodeFrame(bytes)).toEqual({ kind: 'invalid', reason });
}

function expectRoundTrip(frame: Frame): void {
    expect(decodeFrame(encodeFrame(frame))).toEqual({ kind: 'frame', frame });
}

describe('encodeFrame and decodeFrame', () => {
    it('round-trips an IPv4 OPEN', () => {
        const frame: Frame = {
            type: FrameType.OPEN,
            streamId: stream(1),
            family: 4,
            address: Uint8Array.of(203, 0, 113, 7),
            port: 51_234,
        };
        expect(toHex(encodeFrame(frame))).toBe('010000000104cb007107c822');
        expectRoundTrip(frame);
    });

    it('round-trips an IPv6 OPEN', () => {
        const frame: Frame = {
            type: FrameType.OPEN,
            streamId: stream(2),
            family: 6,
            address: fromHex('20010db8000000000000000000000001'),
            port: 443,
        };
        expect(toHex(encodeFrame(frame))).toBe('01000000020620010db800000000000000000000000101bb');
        expectRoundTrip(frame);
    });

    it('accepts a DATA payload of exactly MAX_FRAME_PAYLOAD_BYTES', () => {
        const frame: Frame = {
            type: FrameType.DATA,
            streamId: stream(1),
            payload: new Uint8Array(MAX_FRAME_PAYLOAD_BYTES).fill(7),
        };
        expect(encodeFrame(frame)).toHaveLength(5 + MAX_FRAME_PAYLOAD_BYTES);
        expectRoundTrip(frame);
    });

    it('rejects a payload one byte over the maximum', () => {
        expectInvalid(raw(FrameType.DATA, 1, new Uint8Array(MAX_FRAME_PAYLOAD_BYTES + 1)), 'payload-too-large');
    });

    it.each([1, 0xffff_ffff])('accepts stream ID %i', (id) => {
        expectRoundTrip({ type: FrameType.DATA, streamId: stream(id), payload: Uint8Array.of(1) });
        expect(toHex(raw(FrameType.DATA, id, [1]).subarray(1, 5))).toBe(id === 1 ? '00000001' : 'ffffffff');
    });

    it('rejects stream ID 0', () => {
        expectInvalid(raw(FrameType.DATA, 0, [1]), 'stream-id-zero');
    });

    it.each(Object.values(CLOSE_CODE))('round-trips CLOSE with code %i', (code: CloseCode) => {
        expectRoundTrip({ type: FrameType.CLOSE, streamId: stream(9), code });
    });

    it.each([1, 65_536, 0x7fff_ffff])('round-trips WINDOW with increment %i', (increment) => {
        expectRoundTrip({ type: FrameType.WINDOW, streamId: stream(3), increment });
    });

    it('decodes from a view into a larger buffer without reading outside it', () => {
        const backing = new Uint8Array(32).fill(0xee);
        backing.set(raw(FrameType.CLOSE, 5, [CLOSE_CODE.RESET]), 10);
        const result = decodeFrame(backing.subarray(10, 16));
        expect(result).toEqual({
            kind: 'frame',
            frame: { type: FrameType.CLOSE, streamId: 5, code: CLOSE_CODE.RESET },
        });
    });

    it('copies the DATA payload, so later writes to the input do not change the frame', () => {
        const bytes = raw(FrameType.DATA, 1, [1, 2, 3]);
        const result = decodeFrame(bytes);
        bytes[5] = 9;
        expect(result.kind === 'frame' && result.frame.type === FrameType.DATA && [...result.frame.payload]).toEqual([
            1, 2, 3,
        ]);
    });
});

describe('decodeFrame type byte', () => {
    it('ignores an unknown reserved code with the ignorable flag, without checking the stream ID', () => {
        expect(decodeFrame(raw(FRAME_IGNORABLE_FLAG | 5, 0, [1, 2]))).toEqual({ kind: 'ignored', typeCode: 5 });
        expect(decodeFrame(raw(0xff, 7))).toEqual({ kind: 'ignored', typeCode: 127 });
    });

    it('still applies the length checks to an ignorable frame', () => {
        expectInvalid(Uint8Array.of(0x85, 0, 0, 0), 'too-short');
        expectInvalid(raw(0x85, 1, new Uint8Array(MAX_FRAME_PAYLOAD_BYTES + 1)), 'payload-too-large');
    });

    it('rejects an unknown code without the flag as unknown-type', () => {
        expectInvalid(raw(5, 1, [1]), 'unknown-type');
        expectInvalid(raw(0x7f, 1, [1]), 'unknown-type');
    });

    it('rejects code 0 with and without the ignorable flag', () => {
        expectInvalid(raw(0x00, 1, [1]), 'unknown-type');
        expectInvalid(raw(0x80, 1, [1]), 'unknown-type');
    });

    it.each(Object.values(FrameType))('rejects known code %i with the ignorable flag as bad-flags', (type) => {
        expectInvalid(raw(FRAME_IGNORABLE_FLAG | type, 1, [0]), 'bad-flags');
    });
});

describe('decodeFrame invalid reasons', () => {
    it.each([0, 1, 4])('too-short: %i bytes', (length) => {
        expectInvalid(new Uint8Array(length), 'too-short');
    });

    it('empty-data', () => {
        expectInvalid(raw(FrameType.DATA, 1), 'empty-data');
    });

    it.each([
        ['empty payload', []],
        ['family 5', [5, 1, 2, 3, 4, 0, 80]],
        ['family 0', [0]],
        ['IPv4 one byte short', [4, 1, 2, 3, 4, 0]],
        ['IPv4 one byte long', [4, 1, 2, 3, 4, 0, 80, 0]],
        ['IPv4 family with an IPv6 address', [4, ...new Array<number>(16).fill(0), 0, 80]],
        ['IPv6 one byte short', [6, ...new Array<number>(16).fill(0), 0]],
        ['IPv6 family with an IPv4 address', [6, 1, 2, 3, 4, 0, 80]],
    ])('bad-open-payload: %s', (_, payload) => {
        expectInvalid(raw(FrameType.OPEN, 1, payload), 'bad-open-payload');
    });

    it('CLOSE: too-short, trailing-bytes, bad-close-code', () => {
        expectInvalid(raw(FrameType.CLOSE, 1), 'too-short');
        expectInvalid(raw(FrameType.CLOSE, 1, [0, 0]), 'trailing-bytes');
        expectInvalid(raw(FrameType.CLOSE, 1, [5]), 'bad-close-code');
        expectInvalid(raw(FrameType.CLOSE, 1, [0xff]), 'bad-close-code');
    });

    it('WINDOW: too-short, trailing-bytes, bad-window-increment', () => {
        expectInvalid(raw(FrameType.WINDOW, 1, [0, 0, 1]), 'too-short');
        expectInvalid(raw(FrameType.WINDOW, 1, [0, 0, 0, 1, 0]), 'trailing-bytes');
        expectInvalid(raw(FrameType.WINDOW, 1, [0, 0, 0, 0]), 'bad-window-increment');
        expectInvalid(raw(FrameType.WINDOW, 1, [0x80, 0, 0, 0]), 'bad-window-increment');
        expectInvalid(raw(FrameType.WINDOW, 1, [0xff, 0xff, 0xff, 0xff]), 'bad-window-increment');
    });

    it('checks the payload size before the type byte and the stream ID', () => {
        expectInvalid(raw(0, 0, new Uint8Array(MAX_FRAME_PAYLOAD_BYTES + 1)), 'payload-too-large');
    });
});

describe('encodeFrame refuses frames the decoder would reject', () => {
    const streamId = stream(1);
    it.each<[string, Frame]>([
        ['stream ID 0', { type: FrameType.DATA, streamId: 0 as StreamId, payload: Uint8Array.of(1) }],
        ['stream ID above u32', { type: FrameType.DATA, streamId: (2 ** 32) as StreamId, payload: Uint8Array.of(1) }],
        ['fractional stream ID', { type: FrameType.DATA, streamId: 1.5 as StreamId, payload: Uint8Array.of(1) }],
        ['empty DATA', { type: FrameType.DATA, streamId, payload: new Uint8Array() }],
        ['oversized DATA', { type: FrameType.DATA, streamId, payload: new Uint8Array(MAX_FRAME_PAYLOAD_BYTES + 1) }],
        ['IPv4 with 16 bytes', { type: FrameType.OPEN, streamId, family: 4, address: new Uint8Array(16), port: 1 }],
        ['IPv6 with 4 bytes', { type: FrameType.OPEN, streamId, family: 6, address: new Uint8Array(4), port: 1 }],
        ['port above u16', { type: FrameType.OPEN, streamId, family: 4, address: new Uint8Array(4), port: 65_536 }],
        ['negative port', { type: FrameType.OPEN, streamId, family: 4, address: new Uint8Array(4), port: -1 }],
        ['fractional port', { type: FrameType.OPEN, streamId, family: 4, address: new Uint8Array(4), port: 1.5 }],
        ['unknown CLOSE code', { type: FrameType.CLOSE, streamId, code: 5 as CloseCode }],
        ['WINDOW 0', { type: FrameType.WINDOW, streamId, increment: 0 }],
        ['WINDOW above 2^31-1', { type: FrameType.WINDOW, streamId, increment: 2 ** 31 }],
        ['fractional WINDOW', { type: FrameType.WINDOW, streamId, increment: 1.5 }],
    ])('%s', (_, frame) => {
        expect(() => encodeFrame(frame)).toThrow(RangeError);
    });

    it('accepts ports 0 and 65535', () => {
        for (const port of [0, 65_535]) {
            expectRoundTrip({ type: FrameType.OPEN, streamId, family: 4, address: new Uint8Array(4), port });
        }
    });
});

describe('StreamId', () => {
    it.each([0, -1, 2 ** 32, 1.5, Number.NaN])('rejects %d', (value) => {
        expect(StreamId.safeParse(value).success).toBe(false);
    });
});
