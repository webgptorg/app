import { Ed25519PublicKey, type EngineId } from '@ptbk/protocol';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { orgIdSchema } from '../../domain/ids';
import type { HeartbeatEngineReader } from '../../domain/status/heartbeat-engine-reader';
import { engineLabelSchema } from '../../shared/engine-label';
import type { Database } from './client';
import { engines } from './schema';

const engineStatusSchema = z.enum(['active', 'suspended']);

/**
 * Selects the organization, key and status, what the heartbeat route needs, and the owner's label for the status emails;
 * none of it is ever answered to the engine.
 */
export function createD1HeartbeatEngineReader(db: Database): HeartbeatEngineReader {
    return {
        async findEngine(engineId: EngineId) {
            const row = await db
                .select({
                    orgId: engines.orgId,
                    publicKey: engines.publicKey,
                    status: engines.status,
                    label: engines.label,
                })
                .from(engines)
                .where(eq(engines.engineId, engineId))
                .get();
            return row === undefined
                ? null
                : {
                      orgId: orgIdSchema.parse(row.orgId),
                      publicKey: Ed25519PublicKey.parse(row.publicKey),
                      status: engineStatusSchema.parse(row.status),
                      label: row.label === null ? null : engineLabelSchema.parse(row.label),
                  };
        },
    };
}
