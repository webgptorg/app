import { RELAY_TOKEN_PATTERN, sha256Hex } from '../auth/secrets';
import type { RelayTokenId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { RelayTokenStore } from './relay-token-store';

/** `last_used_at` is for spotting unused keys before rotation, so minute precision is plenty and saves a write per call. */
export const LAST_USED_RESOLUTION_MS = 60_000;

export interface RelayActor {
    readonly tokenId: RelayTokenId;
    readonly relayId: string;
}

export interface AuthenticateRelayDeps {
    readonly relayTokens: RelayTokenStore;
    readonly clock: Clock;
    readonly logger: Logger;
}

const BEARER = /^Bearer (\S+)$/i;

/**
 * The relay-token auth mode. A malformed header is refused before any query; a well-formed token is looked up only by
 * its hash. `defer` runs the `last_used_at` write after the response (Workers `waitUntil`).
 */
export async function authenticateRelay(
    deps: AuthenticateRelayDeps,
    authorization: string | null,
    defer: (task: Promise<unknown>) => void,
): Promise<RelayActor | null> {
    const token = BEARER.exec(authorization ?? '')?.[1];
    if (token === undefined || !RELAY_TOKEN_PATTERN.test(token)) {
        deps.logger.warn('relay.unauthorized', { reason: authorization === null ? 'missing' : 'malformed' });
        return null;
    }
    const now = deps.clock.nowMs();
    const row = await deps.relayTokens.findLive(await sha256Hex(token), now);
    if (row === null) {
        deps.logger.warn('relay.unauthorized', { reason: 'unknown' });
        return null;
    }
    if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
        defer(
            deps.relayTokens.markUsed(row.id, now).catch(() => {
                deps.logger.error('relay.mark-used-failed', { tokenId: row.id, relayId: row.relayId });
            }),
        );
    }
    return { tokenId: row.id, relayId: row.relayId };
}
