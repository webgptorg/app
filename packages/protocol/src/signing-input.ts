import type { Bytes } from './bytes';
import { concatBytes, utf8Encode } from './bytes';

/** Every engine-key signature purpose (ADR 0010 §5). A changed input gets a new version, a new purpose a new context. */
export const SIGNING_CONTEXT = Object.freeze({
    tunnel: 'ptbk-tunnel-v1',
    hostname: 'ptbk-hostname-v1',
    register: 'ptbk-register-v1',
    heartbeat: 'ptbk-heartbeat-v1',
} as const);

export type SigningContext = (typeof SIGNING_CONTEXT)[keyof typeof SIGNING_CONTEXT];

const CONTEXTS: ReadonlySet<string> = new Set(Object.values(SIGNING_CONTEXT));
// Can never start a DSSE PAE (`DSSEv1 `), so an engine-key signature and a release signature cannot be confused.
const PREFIX = utf8Encode('ptbk-sig\0');
const MAX_PART_BYTES = 0xffff_ffff;

/**
 * `"ptbk-sig\0" ‖ u8 len(context) ‖ context ‖ (u32be len(part) ‖ part)…` (ADR 0014). String parts are UTF-8; binary
 * values (nonces, hashes, public keys) go in as raw bytes, never as base64url text. Unambiguous for any part content.
 * Throws only on a context outside `SIGNING_CONTEXT` or a part over 4 GiB, both bugs rather than inputs.
 */
export function signingInput(context: SigningContext, ...parts: readonly (string | Bytes)[]): Bytes {
    if (!CONTEXTS.has(context)) throw new RangeError(`unknown signing context: ${context}`);
    const encoded: Uint8Array[] = [PREFIX, Uint8Array.of(context.length), utf8Encode(context)];
    for (const part of parts) {
        const bytes = typeof part === 'string' ? utf8Encode(part) : part;
        if (bytes.length > MAX_PART_BYTES) throw new RangeError('signing input part exceeds 4 GiB');
        const length = new Uint8Array(4);
        new DataView(length.buffer).setUint32(0, bytes.length);
        encoded.push(length, bytes);
    }
    return concatBytes(...encoded);
}
