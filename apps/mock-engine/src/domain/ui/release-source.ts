import type { EngineVersion } from '@ptbk/protocol';

/**
 * Where releases come from: the release store or a mirror. Everything it returns is untrusted until
 * `verifyRelease` and the hash checks pass. Any failure to fetch (network, timeout, status, size cap) throws; the loader
 * reports it as `unavailable` and keeps what it serves.
 */
export interface ReleaseSource {
    /** The newest published UI version, as the store advertises it (unsigned: only a hint of what to fetch). */
    latest(signal: AbortSignal): Promise<EngineVersion>;
    /** The `SignedRelease` JSON value for `version`, as fetched and unparsed. */
    release(version: EngineVersion, signal: AbortSignal): Promise<unknown>;
    /** The revocation list's DSSE envelope JSON value as fetched, or `null` when the store has none. */
    revocations(signal: AbortSignal): Promise<unknown>;
    /** The bytes of one artifact of `version`, streamed and capped by the source. */
    artifact(version: EngineVersion, name: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}
