import { assertLimits, createClientHelloParser, NEED_MORE } from './client-hello';
import type { ClientHelloLimits, ClientHelloParse } from './client-hello';

export interface ClientHelloBufferLimits extends ClientHelloLimits {
    /**
     * Chunks the ClientHello may take: the push that reaches this many without a verdict is answered with
     * `malformed` (`too-fragmented`). Browsers send a ClientHello in one to three. Unset: no limit.
     */
    readonly maxChunks?: number;
}

export interface ClientHelloBuffer {
    /**
     * Appends a chunk and parses the bytes not parsed before. Once the outcome is anything but
     * `need-more` it is final: later chunks are neither buffered nor parsed, and the same outcome
     * is returned, so the caller pipes or drops the rest of the stream itself.
     */
    push(chunk: Uint8Array): ClientHelloParse;
    /** Every byte buffered so far, including any that followed the ClientHello in the same chunk. */
    bytes(): Uint8Array;
}

const TOO_FRAGMENTED: ClientHelloParse = Object.freeze({ kind: 'malformed', reason: 'too-fragmented' });

/**
 * Accumulates the first chunks of a connection until its ClientHello can be judged. Holds at most
 * `maxBytes - 1` bytes plus one chunk, because reaching `maxBytes` always ends the parse, and keeps
 * its place between chunks, so a ClientHello trickling in byte by byte costs no more to parse than
 * one arriving whole.
 */
export function createClientHelloBuffer(limits: ClientHelloBufferLimits): ClientHelloBuffer {
    assertLimits(limits);
    const { maxChunks } = limits;
    if (maxChunks !== undefined && !(Number.isSafeInteger(maxChunks) && maxChunks >= 1)) {
        throw new RangeError('maxChunks must be a positive integer');
    }
    const parser = createClientHelloParser(limits);
    let storage = new Uint8Array(0);
    let length = 0;
    let chunks = 0;
    let outcome = NEED_MORE;

    return {
        push(chunk) {
            if (outcome.kind !== 'need-more') return outcome;
            if (length + chunk.byteLength > storage.byteLength) {
                const grown = new Uint8Array(Math.max(length + chunk.byteLength, storage.byteLength * 2));
                grown.set(storage.subarray(0, length));
                storage = grown;
            }
            storage.set(chunk, length);
            length += chunk.byteLength;
            chunks++;
            outcome = parser.feed(storage.subarray(0, length));
            if (outcome.kind === 'need-more' && maxChunks !== undefined && chunks >= maxChunks)
                outcome = TOO_FRAGMENTED;
            return outcome;
        },
        bytes() {
            return storage.subarray(0, length);
        },
    };
}
