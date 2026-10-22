import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseClientHello } from './client-hello';
import type { ClientHelloParse } from './client-hello';
import { createClientHelloBuffer } from './client-hello-buffer';
import {
    alpnExtension,
    clientHello,
    concat,
    extension,
    handshakeMessage,
    clientHelloBody,
    paddingExtension,
    record,
    serverNameExtension,
    u24,
    u8,
} from './fixtures/build-client-hello';
import { CAPTURED_CLIENT_HELLOS } from './fixtures/captured';

const limits = { maxBytes: 16 * 1024 };

const KINDS = new Set(['need-more', 'sni', 'no-sni', 'malformed', 'too-large']);
const REASONS = new Set([
    'not-handshake',
    'unsupported-record-version',
    'not-client-hello',
    'length-mismatch',
    'bad-extensions',
    'duplicate-extension',
    'bad-server-name',
]);

function expectWellFormed(result: ClientHelloParse): void {
    expect(KINDS.has(result.kind)).toBe(true);
    if (result.kind === 'malformed') expect(REASONS.has(result.reason)).toBe(true);
}

function splitAt(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
    const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort((a, b) => a - b);
    return [...points, bytes.length].map((end, index) => bytes.subarray(points[index - 1] ?? 0, end));
}

function feed(bytes: Uint8Array, cuts: readonly number[], maxBytes: number): ClientHelloParse {
    const buffer = createClientHelloBuffer({ maxBytes });
    let result: ClientHelloParse = { kind: 'need-more' };
    for (const chunk of splitAt(bytes, cuts)) result = buffer.push(chunk);
    return result;
}

const fixture = fc.constantFrom(...CAPTURED_CLIENT_HELLOS);

const byteFlips = fc.array(fc.record({ index: fc.nat(), mask: fc.integer({ min: 1, max: 255 }) }), {
    minLength: 1,
    maxLength: 8,
});

function withFlips(bytes: Uint8Array, flips: readonly { index: number; mask: number }[]): Uint8Array {
    const mutated = bytes.slice();
    for (const { index, mask } of flips) {
        const at = index % mutated.length;
        mutated[at] = (mutated[at] ?? 0) ^ mask;
    }
    return mutated;
}

const ldhLabel = fc.stringMatching(/^[A-Za-z0-9-]{1,63}$/);
const hostname = fc
    .array(ldhLabel, { minLength: 1, maxLength: 5 })
    .map((labels) => labels.join('.'))
    .filter((name) => name.length <= 253);

/** Extension types the parser has no rules for: not server_name, ALPN or padding. */
const otherExtensionType = fc.integer({ min: 1, max: 0xffff }).filter((type) => ![0, 16, 21].includes(type));

const generatedHello = fc
    .record({
        hostname,
        alpn: fc.option(fc.array(fc.stringMatching(/^[\x21-\x7e]{1,20}$/), { minLength: 1, maxLength: 4 })),
        padding: fc.option(fc.nat({ max: 1024 })),
        others: fc.uniqueArray(fc.record({ type: otherExtensionType, data: fc.uint8Array({ maxLength: 64 }) }), {
            selector: (other) => other.type,
            maxLength: 6,
        }),
        fragments: fc.array(fc.integer({ min: 1, max: 600 }), { maxLength: 4 }),
        seed: fc.nat(),
    })
    .chain((spec) => {
        const extensions = [
            serverNameExtension(spec.hostname),
            ...(spec.alpn === null ? [] : [alpnExtension(...spec.alpn)]),
            ...(spec.padding === null ? [] : [paddingExtension(spec.padding)]),
            ...spec.others.map((other) => extension(other.type, other.data)),
        ];
        return fc
            .shuffledSubarray(extensions, { minLength: extensions.length })
            .map((shuffled) => ({ spec, bytes: clientHello(shuffled, spec.fragments) }));
    });

describe('parseClientHello properties', () => {
    it('gives the same result fed chunk by chunk as in one go, for every split of every fixture', () => {
        fc.assert(
            fc.property(fixture, fc.array(fc.nat(), { maxLength: 12 }), ({ bytes, expected }, cuts) => {
                expect(feed(bytes, cuts, limits.maxBytes)).toEqual(expected);
            }),
        );
    });

    it('gives the same verdict for random bytes split into random chunks as in one go', () => {
        fc.assert(
            fc.property(
                fc.oneof(
                    fc.uint8Array({ maxLength: 4096 }),
                    fc.uint8Array({ maxLength: 4096 }).map((body) => record(concat(u8(1), u24(body.length), body))),
                ),
                fc.array(fc.nat(), { maxLength: 63 }),
                fc.option(fc.integer({ min: 1, max: 8192 })),
                (bytes, cuts, maxHelloBytes) => {
                    const chosen = maxHelloBytes === null ? limits : { ...limits, maxHelloBytes };
                    const buffer = createClientHelloBuffer({ ...chosen, maxChunks: 64 });
                    let result: ClientHelloParse = { kind: 'need-more' };
                    for (const chunk of splitAt(bytes, cuts)) result = buffer.push(chunk);
                    expect(result).toEqual(parseClientHello(bytes, chosen));
                },
            ),
        );
    });

    it('reaches the one-shot verdict on a generated multi-record ClientHello within maxChunks, and too-fragmented beyond', () => {
        fc.assert(
            fc.property(
                generatedHello,
                fc.array(fc.nat(), { maxLength: 24 }),
                fc.integer({ min: 1, max: 16 }),
                ({ bytes }, cuts, maxChunks) => {
                    const chunks = splitAt(bytes, cuts).filter((chunk) => chunk.length > 0);
                    const buffer = createClientHelloBuffer({ ...limits, maxChunks });
                    let result: ClientHelloParse = { kind: 'need-more' };
                    for (const chunk of chunks) result = buffer.push(chunk);
                    expect(result).toEqual(
                        chunks.length <= maxChunks
                            ? parseClientHello(bytes, limits)
                            : { kind: 'malformed', reason: 'too-fragmented' },
                    );
                },
            ),
        );
    });

    it('applies maxHelloBytes to the handshake across records, fed in any chunks', () => {
        const maxHelloBytes = 32 * 1024;
        // Room for every record header, so only maxHelloBytes decides.
        const roomy = { maxBytes: 64 * 1024, maxHelloBytes };
        fc.assert(
            fc.property(
                fc.integer({ min: 30_000, max: 34_000 }),
                fc.array(fc.integer({ min: 1, max: 4096 }), { maxLength: 4 }),
                fc.array(fc.nat(), { maxLength: 63 }),
                (padding, fragments, cuts) => {
                    const extensions = [serverNameExtension('a.example'), paddingExtension(padding)];
                    const handshakeBytes = handshakeMessage(1, clientHelloBody(extensions)).length;
                    const bytes = clientHello(extensions, fragments);
                    const buffer = createClientHelloBuffer({ ...roomy, maxChunks: 64 });
                    let result: ClientHelloParse = { kind: 'need-more' };
                    for (const chunk of splitAt(bytes, cuts)) result = buffer.push(chunk);
                    expect(result.kind).toBe(handshakeBytes <= maxHelloBytes ? 'sni' : 'too-large');
                },
            ),
        );
    });

    it('returns need-more for every strict prefix of every fixture', () => {
        for (const { name, bytes } of CAPTURED_CLIENT_HELLOS) {
            for (let length = 0; length < bytes.length; length++) {
                expect(parseClientHello(bytes.subarray(0, length), limits), `${name}[0, ${String(length)})`).toEqual({
                    kind: 'need-more',
                });
            }
        }
    });

    it('never throws on arbitrary bytes up to 20 KiB', () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 20 * 1024 }), (bytes) => {
                expectWellFormed(parseClientHello(bytes, limits));
            }),
        );
    });

    it('never throws on arbitrary bytes behind a valid record and handshake header', () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 4096 }), fc.nat({ max: 8192 }), (body, declared) => {
                const bytes = record(concat(u8(1), u24(declared), body));
                expectWellFormed(parseClientHello(bytes, limits));
            }),
        );
    });

    it('never throws on random byte flips of valid fixtures, in one go or chunk by chunk', () => {
        fc.assert(
            fc.property(fixture, byteFlips, fc.array(fc.nat(), { maxLength: 6 }), ({ bytes }, flips, cuts) => {
                const mutated = withFlips(bytes, flips);
                const whole = parseClientHello(mutated, limits);
                expectWellFormed(whole);
                expect(feed(mutated, cuts, limits.maxBytes)).toEqual(whole);
            }),
        );
    });

    it('returns sni with the hostname of a generated valid ClientHello', () => {
        fc.assert(
            fc.property(generatedHello, ({ spec, bytes }) => {
                expect(parseClientHello(bytes, limits)).toEqual({
                    kind: 'sni',
                    hostname: spec.hostname.toLowerCase(),
                    alpn: spec.alpn ?? [],
                });
            }),
        );
    });

    it('parses a ClientHello of exactly maxBytes and returns too-large for any smaller limit', () => {
        fc.assert(
            fc.property(generatedHello, fc.nat(), fc.array(fc.nat(), { maxLength: 6 }), ({ bytes }, shrink, cuts) => {
                expect(parseClientHello(bytes, { maxBytes: bytes.length }).kind).toBe('sni');
                const maxBytes = bytes.length - 1 - (shrink % (bytes.length - 1));
                expect(parseClientHello(bytes, { maxBytes })).toEqual({ kind: 'too-large' });
                expect(feed(bytes, cuts, maxBytes)).toEqual({ kind: 'too-large' });
            }),
        );
    });

    it('never returns need-more once maxBytes bytes are present', () => {
        fc.assert(
            fc.property(fixture, fc.nat(), byteFlips, ({ bytes }, limit, flips) => {
                const maxBytes = 1 + (limit % bytes.length);
                expect(parseClientHello(withFlips(bytes, flips), { maxBytes }).kind).not.toBe('need-more');
            }),
        );
    });
});
