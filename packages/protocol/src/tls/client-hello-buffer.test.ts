import { describe, expect, it } from 'vitest';
import { createClientHelloBuffer } from './client-hello-buffer';
import { clientHello, concat, latin1, serverNameExtension } from './fixtures/build-client-hello';

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
});
