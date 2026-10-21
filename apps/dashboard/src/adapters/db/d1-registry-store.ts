import { Ed25519PublicKey, type EngineId } from '@ptbk/protocol';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { relayTokenIdSchema } from '../../domain/ids';
import type { RegistryReader } from '../../domain/registry/registry-reader';
import type { RelayTokenStore } from '../../domain/registry/relay-token-store';
import type { Database } from './client';
import { engines, relayTokens } from './schema';

const engineStatusSchema = z.enum(['active', 'suspended']);

export function createD1RelayTokenStore(db: Database): RelayTokenStore {
    return {
        async findLive(tokenHash, now) {
            const row = await db
                .select({ id: relayTokens.id, relayId: relayTokens.relayId, lastUsedAt: relayTokens.lastUsedAt })
                .from(relayTokens)
                .where(
                    and(
                        eq(relayTokens.tokenHash, tokenHash),
                        isNull(relayTokens.revokedAt),
                        gt(relayTokens.expiresAt, now),
                    ),
                )
                .get();
            return row === undefined ? null : { ...row, id: relayTokenIdSchema.parse(row.id) };
        },

        async markUsed(id, now) {
            await db.update(relayTokens).set({ lastUsedAt: now }).where(eq(relayTokens.id, id));
        },
    };
}

/** Selects the key and status only: the organization column never leaves the database on this path. */
export function createD1RegistryReader(db: Database): RegistryReader {
    return {
        async findEngine(engineId: EngineId) {
            const row = await db
                .select({ publicKey: engines.publicKey, status: engines.status })
                .from(engines)
                .where(eq(engines.engineId, engineId))
                .get();
            return row === undefined
                ? null
                : { publicKey: Ed25519PublicKey.parse(row.publicKey), status: engineStatusSchema.parse(row.status) };
        },
    };
}
