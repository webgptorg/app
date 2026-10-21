import type { RelayTokenId } from '../ids';

/** A token row that authenticates now: not revoked and not expired. */
export interface LiveRelayToken {
    readonly id: RelayTokenId;
    readonly relayId: string;
    readonly lastUsedAt: number | null;
}

/**
 * Relay keys in D1, looked up only by the token's SHA-256 (ADR 0014). Rows are written by `scripts/mint-relay-key.ts`
 * through wrangler, never by the Worker.
 */
export interface RelayTokenStore {
    findLive(tokenHash: string, now: number): Promise<LiveRelayToken | null>;
    markUsed(id: RelayTokenId, now: number): Promise<void>;
}
