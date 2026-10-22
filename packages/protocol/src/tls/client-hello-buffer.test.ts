import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientHelloBuffer } from './client-hello-buffer';
import { clientHello, concat, latin1, paddingExtension, serverNameExtension } from './fixtures/build-client-hello';

const hello = clientHello([serverNameExtension('a.example')]);
const sni = { kind: 'sni', hostname: 'a.example', alpn: [] };

describe('createClientHelloBuffer', () => {
    it('returns need-more until the ClientHello is complete', () => {
        const buffer = createClientHelloBuffer({ maxBytes: 1024 });
        expect(buffer.push(hello.subarray(0, 3))).toEqual({ kind: 'need-more' });
        expect(buffer.push(hello.subarray(3, 40))).toEqual({ kind: 'need-more' });
        expect(buffer.push(hello.subarray(40))).toEqual(sni);
    });

    it('keeps bytes that arrived after the ClientHello in the same chunk', () => {
        const buffer = createClientHelloBuffer({ maxBytes: 1024 });
        const stream = concat(hello, latin1('after'));
        buffer.push(stream.subarray(0, 10));
        expect(buffer.push(stream.subarray(10))).toEqual(sni);
        expect(buffer.bytes()).toEqual(stream);
    });

    it('stops buffering once the outcome is final', () => {
        const buffer = createClientHelloBuffer({ maxBytes: 1024 });
        expect(buffer.push(latin1('GET / HTTP/1.1\r\n'))).toEqual({ kind: 'malformed', reason: 'not-handshake' });
        expect(buffer.push(hello)).toEqual({ kind: 'malformed', reason: 'not-handshake' });
        expect(buffer.bytes()).toEqual(latin1('GET / HTTP/1.1\r\n'));
    });

    it('returns too-large once maxBytes bytes are buffered without a ClientHello length', () => {
        const buffer = createClientHelloBuffer({ maxBytes: 8 });
        expect(buffer.push(Uint8Array.of(0x16, 0x03, 0x01, 0x00, 0x02, 0x01))).toEqual({ kind: 'need-more' });
        expect(buffer.push(Uint8Array.of(0x00, 0x16, 0x03))).toEqual({ kind: 'too-large' });
    });

    it('returns need-more for an empty chunk', () => {
        expect(createClientHelloBuffer({ maxBytes: 1024 }).push(new Uint8Array(0))).toEqual({ kind: 'need-more' });
    });

    it('throws on an invalid maxBytes', () => {
        expect(() => createClientHelloBuffer({ maxBytes: 0 })).toThrow(RangeError);
    });

    it('throws on an invalid maxChunks', () => {
        expect(() => createClientHelloBuffer({ maxBytes: 1024, maxChunks: 0 })).toThrow(RangeError);
        expect(() => createClientHelloBuffer({ maxBytes: 1024, maxChunks: 1.5 })).toThrow(RangeError);
    });
});

describe('createClientHelloBuffer against a trickling client', () => {
    // About 16 KiB, so it spans two records, as a post-quantum key share makes real ClientHellos do.
    const large = clientHello([serverNameExtension('a.example'), paddingExtension(16_200)]);

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('refuses a ClientHello still incomplete after maxChunks chunks', () => {
        const buffer = createClientHelloBuffer({ maxBytes: 32 * 1024, maxChunks: 64 });
        for (let index = 0; index < 63; index++) {
            expect(buffer.push(large.subarray(index, index + 1))).toEqual({ kind: 'need-more' });
        }
        expect(buffer.push(large.subarray(63, 64))).toEqual({ kind: 'malformed', reason: 'too-fragmented' });
        expect(buffer.push(large.subarray(64))).toEqual({ kind: 'malformed', reason: 'too-fragmented' });
        expect(buffer.bytes()).toHaveLength(64);
    });

    it('accepts a ClientHello completed by the last allowed chunk', () => {
        const buffer = createClientHelloBuffer({ maxBytes: 32 * 1024, maxChunks: 3 });
        buffer.push(large.subarray(0, 100));
        buffer.push(large.subarray(100, 9000));
        expect(buffer.push(large.subarray(9000))).toEqual(sni);
    });

    it('examines each byte once, however small the chunks', () => {
        // Every byte is copied into the buffer, at most twice more as it grows, and once into the reassembled
        // handshake; parsing everything again on each chunk would copy about length²/2 bytes.
        const copied = vi.spyOn(Uint8Array.prototype, 'set');
        const buffer = createClientHelloBuffer({ maxBytes: 32 * 1024 });
        let result = buffer.push(large.subarray(0, 1));
        for (let index = 1; index < large.length; index++) result = buffer.push(large.subarray(index, index + 1));
        expect(result).toEqual(sni);
        const total = copied.mock.calls.reduce((sum, [source]) => sum + source.length, 0);
        expect(total).toBeLessThanOrEqual(5 * large.length);
    });
});
