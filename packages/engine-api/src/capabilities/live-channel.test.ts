import { describe, expect, it } from 'vitest';

import {
    LIVE_MEDIA_HEADER_BYTES,
    LiveEngineMessage,
    MAX_LIVE_CONTROL_MESSAGE_BYTES,
    MAX_LIVE_MEDIA_BYTES,
    TabOrigin,
    agreeLiveChannelVersion,
    decodeLiveMedia,
    encodeLiveMedia,
    parseLiveClientMessage,
    readLiveEngineMessage,
} from './live-channel';

const json = (value: unknown): string => JSON.stringify(value);
const pointer = { kind: 'pointer', action: 'down', x: 10, y: 20.5, button: 'left', clicks: 1 };

describe('parseLiveClientMessage', () => {
    it.each([
        { type: 'hello', versions: [1, 2] },
        { type: 'view', width: 640, height: 400, visible: false },
        { type: 'frame-ack', seq: 4_294_967_295 },
        { type: 'input', event: pointer },
        { type: 'input', event: { kind: 'wheel', x: 0, y: 0, deltaX: -120, deltaY: 120 } },
        { type: 'input', event: { kind: 'key', action: 'down', key: 'Enter', shift: false } },
        { type: 'input', event: { kind: 'key', action: 'down', key: 'é', shift: true } },
        { type: 'input', event: { kind: 'key', action: 'up', key: '😀', shift: false } },
        { type: 'input', event: { kind: 'key', action: 'down', key: ' ', shift: false } },
        { type: 'end' },
    ])('takes %j', (message) => {
        expect(parseLiveClientMessage(json(message))).toEqual({ kind: 'ok', message });
    });

    it.each([
        ['an unknown type', { type: 'eval', code: '1' }],
        ['an unknown field', { type: 'end', reason: 'ended' }],
        ['no versions', { type: 'hello', versions: [] }],
        ['a repeated version', { type: 'hello', versions: [1, 1] }],
        ['a negative sequence', { type: 'frame-ack', seq: -1 }],
        ['a fractional sequence', { type: 'frame-ack', seq: 1.5 }],
        ['a view too large', { type: 'view', width: 20_000, height: 400, visible: true }],
        ['a pointer off the tab', { type: 'input', event: { ...pointer, x: -1 } }],
        ['a pointer too far', { type: 'input', event: { ...pointer, y: 16_385 } }],
        ['an unknown button', { type: 'input', event: { ...pointer, button: 'back' } }],
        ['a triple-plus click', { type: 'input', event: { ...pointer, clicks: 4 } }],
        ['a navigation', { type: 'input', event: { kind: 'navigate', url: 'https://example.com' } }],
        ['a CDP command', { type: 'input', event: { kind: 'cdp', method: 'Runtime.evaluate' } }],
        ['clipboard paste', { type: 'input', event: { kind: 'paste', text: 'x' } }],
        [
            'a control modifier',
            { type: 'input', event: { kind: 'key', action: 'down', key: 'v', ctrl: true, shift: false } },
        ],
        ['a function key', { type: 'input', event: { kind: 'key', action: 'down', key: 'F12', shift: false } }],
        ['two characters', { type: 'input', event: { kind: 'key', action: 'down', key: 'ab', shift: false } }],
        ['a control character', { type: 'input', event: { kind: 'key', action: 'down', key: '\u0007', shift: false } }],
        ['a format character', { type: 'input', event: { kind: 'key', action: 'down', key: '‮', shift: false } }],
        ['a huge wheel delta', { type: 'input', event: { kind: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 1e9 } }],
        ['an array', [{ type: 'end' }]],
    ])('refuses %s', (_name, message) => {
        expect(parseLiveClientMessage(json(message))).toEqual({ kind: 'invalid', reason: 'schema' });
    });

    it('refuses text that is not JSON, and messages over the size cap before parsing them', () => {
        expect(parseLiveClientMessage('{"type":')).toEqual({ kind: 'invalid', reason: 'not-json' });
        const padded = json({ type: 'end', pad: 'x'.repeat(MAX_LIVE_CONTROL_MESSAGE_BYTES) });
        expect(parseLiveClientMessage(padded)).toEqual({ kind: 'invalid', reason: 'too-large' });
    });
});

describe('readLiveEngineMessage', () => {
    it('reads every known message, stripping unknown fields and reading unknown values as unknown', () => {
        expect(readLiveEngineMessage(json({ type: 'hello', version: 1, server: 'x' }))).toEqual({
            type: 'hello',
            version: 1,
        });
        expect(
            readLiveEngineMessage(
                json({
                    type: 'state',
                    mode: 'co-driving',
                    agent: 'sleeping',
                    others: 2,
                    viewport: { width: 1, height: 1 },
                }),
            ),
        ).toEqual({ type: 'state', mode: 'unknown', agent: 'unknown', others: 2, viewport: { width: 1, height: 1 } });
        expect(readLiveEngineMessage(json({ type: 'navigated', origin: 'https://example.com' }))).toEqual({
            type: 'navigated',
            origin: 'https://example.com',
        });
        expect(readLiveEngineMessage(json({ type: 'blocked', reason: 'download', origin: null }))).toEqual({
            type: 'blocked',
            reason: 'unknown',
            origin: null,
        });
        expect(readLiveEngineMessage(json({ type: 'input-refused', reason: 'not-controlling' }))).toEqual({
            type: 'input-refused',
            reason: 'not-controlling',
        });
        expect(readLiveEngineMessage(json({ type: 'end', reason: 'crashed' }))).toEqual({
            type: 'end',
            reason: 'unknown',
        });
    });

    it('skips unknown types, non-objects, oversized text and malformed known messages', () => {
        expect(readLiveEngineMessage(json({ type: 'caption', text: 'hi' }))).toBeNull();
        expect(readLiveEngineMessage('null')).toBeNull();
        expect(readLiveEngineMessage('not json')).toBeNull();
        expect(readLiveEngineMessage(json({ type: 'navigated', origin: 'https://example.com/path' }))).toBeNull();
        expect(readLiveEngineMessage(json({ type: 'hello', version: 1, pad: 'x'.repeat(5000) }))).toBeNull();
    });

    it('is the tolerant reading of what the engine must send strictly', () => {
        expect(LiveEngineMessage.safeParse({ type: 'end', reason: 'ended', extra: 1 }).success).toBe(false);
        expect(LiveEngineMessage.safeParse({ type: 'navigated', origin: 'chrome://settings' }).success).toBe(false);
    });
});

describe('TabOrigin', () => {
    it('takes web origins only, never a path, query or browser page', () => {
        expect(TabOrigin.safeParse('http://intranet.example').success).toBe(true);
        for (const origin of ['https://example.com/a', 'https://example.com?q=1', 'chrome://settings', 'file:///etc']) {
            expect(TabOrigin.safeParse(origin).success, origin).toBe(false);
        }
    });
});

describe('agreeLiveChannelVersion', () => {
    it('picks the highest shared version, or none', () => {
        expect(agreeLiveChannelVersion([1, 7])).toBe(1);
        expect(agreeLiveChannelVersion([2])).toBeNull();
    });
});

describe('live media', () => {
    it('round-trips kind, sequence, timestamp and payload', () => {
        const payload = Uint8Array.of(1, 2, 3);
        const encoded = encodeLiveMedia({
            kind: 'tab-frame-jpeg',
            seq: 0xffff_ffff,
            timestamp: 1_763_632_800_123,
            payload,
        });
        if (encoded.kind !== 'ok') throw new Error('not encoded');
        expect(encoded.bytes.byteLength).toBe(LIVE_MEDIA_HEADER_BYTES + 3);
        expect(encoded.bytes[0]).toBe(1);
        expect(decodeLiveMedia(encoded.bytes)).toEqual({
            kind: 'ok',
            media: { kind: 'tab-frame-jpeg', seq: 0xffff_ffff, timestamp: 1_763_632_800_123, payload },
        });
    });

    it('decodes from a view into a larger buffer', () => {
        const encoded = encodeLiveMedia({ kind: 'tab-frame-webp', seq: 7, timestamp: 1, payload: Uint8Array.of(9) });
        if (encoded.kind !== 'ok') throw new Error('not encoded');
        const buffer = new Uint8Array(encoded.bytes.byteLength + 4);
        buffer.set(encoded.bytes, 2);
        const decoded = decodeLiveMedia(buffer.subarray(2, 2 + encoded.bytes.byteLength));
        expect(decoded).toMatchObject({
            kind: 'ok',
            media: { kind: 'tab-frame-webp', seq: 7, payload: Uint8Array.of(9) },
        });
    });

    it('keeps every message within 64 KiB, header included', () => {
        const fits = new Uint8Array(MAX_LIVE_MEDIA_BYTES - LIVE_MEDIA_HEADER_BYTES);
        expect(encodeLiveMedia({ kind: 'tab-frame-png', seq: 1, timestamp: 0, payload: fits }).kind).toBe('ok');
        const over = new Uint8Array(fits.byteLength + 1);
        expect(encodeLiveMedia({ kind: 'tab-frame-png', seq: 1, timestamp: 0, payload: over })).toEqual({
            kind: 'too-large',
            bytes: MAX_LIVE_MEDIA_BYTES + 1,
        });
        expect(decodeLiveMedia(new Uint8Array(MAX_LIVE_MEDIA_BYTES + 1))).toEqual({
            kind: 'invalid',
            reason: 'too-large',
        });
    });

    it('refuses short, unknown and malformed media', () => {
        expect(decodeLiveMedia(new Uint8Array(LIVE_MEDIA_HEADER_BYTES - 1))).toEqual({
            kind: 'invalid',
            reason: 'too-short',
        });
        const unknown = new Uint8Array(LIVE_MEDIA_HEADER_BYTES);
        unknown[0] = 16;
        expect(decodeLiveMedia(unknown)).toEqual({ kind: 'invalid', reason: 'unknown-kind' });
        const nan = new Uint8Array(LIVE_MEDIA_HEADER_BYTES);
        nan[0] = 2;
        new DataView(nan.buffer).setFloat64(5, Number.NaN);
        expect(decodeLiveMedia(nan)).toEqual({ kind: 'invalid', reason: 'bad-timestamp' });
    });

    it('refuses to encode a header it cannot represent', () => {
        const payload = new Uint8Array(0);
        expect(() => encodeLiveMedia({ kind: 'tab-frame-png', seq: -1, timestamp: 0, payload })).toThrow(RangeError);
        expect(() => encodeLiveMedia({ kind: 'tab-frame-png', seq: 2 ** 32, timestamp: 0, payload })).toThrow(
            RangeError,
        );
        expect(() => encodeLiveMedia({ kind: 'tab-frame-png', seq: 0, timestamp: Number.NaN, payload })).toThrow(
            RangeError,
        );
    });
});
