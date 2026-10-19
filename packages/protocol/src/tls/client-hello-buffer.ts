import { assertLimits, NEED_MORE, parseClientHello } from './client-hello';
import type { ClientHelloLimits, ClientHelloParse } from './client-hello';

export interface ClientHelloBuffer {
    /**
     * Appends a chunk and parses everything received so far. Once the outcome is anything but
     * `need-more` it is final: later chunks are neither buffered nor parsed, and the same outcome
     * is returned, so the caller pipes or drops the rest of the stream itself.
     */
    push(chunk: Uint8Array): ClientHelloParse;
    /** Every byte buffered so far, including any that followed the ClientHello in the same chunk. */
    bytes(): Uint8Array;
}

/**
 * Accumulates the first chunks of a connection until its ClientHello can be judged. Holds at most
 * `maxBytes - 1` bytes plus one chunk, because reaching `maxBytes` always ends the parse.
 */
export function createClientHelloBuffer(limits: ClientHelloLimits): ClientHelloBuffer {
    assertLimits(limits);
    let storage = new Uint8Array(0);
    let length = 0;
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
            outcome = parseClientHello(storage.subarray(0, length), limits);
            return outcome;
        },
        bytes() {
            return storage.subarray(0, length);
        },
    };
}
