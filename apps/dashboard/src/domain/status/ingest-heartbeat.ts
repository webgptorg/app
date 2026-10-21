import type { Bytes, EngineId, HeartbeatVerification } from '@ptbk/protocol';

import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { EngineStatusDirectory } from './engine-status-directory';
import type { HeartbeatEngineReader } from './heartbeat-engine-reader';

export interface IngestHeartbeatDeps {
    readonly heartbeatEngines: HeartbeatEngineReader;
    readonly engineStatus: EngineStatusDirectory;
    readonly clock: Clock;
    readonly logger: Logger;
}

export type HeartbeatIngestOutcome =
    HeartbeatVerification | { readonly kind: 'unknown-engine' } | { readonly kind: 'engine-suspended' };

/**
 * The Worker's half of a heartbeat: unknown and suspended engines stop here, so only registered, active engines wake
 * their object, which verifies the heartbeat against its stored `seq`.
 */
export async function ingestHeartbeat(
    deps: IngestHeartbeatDeps,
    input: { readonly engineId: EngineId; readonly rawBody: Bytes; readonly signatureHeader: string | null },
): Promise<HeartbeatIngestOutcome> {
    const receivedAt = deps.clock.nowMs();
    const engine = await deps.heartbeatEngines.findEngine(input.engineId);
    const outcome: HeartbeatIngestOutcome =
        engine === null
            ? { kind: 'unknown-engine' }
            : engine.status === 'suspended'
              ? { kind: 'engine-suspended' }
              : await deps.engineStatus.recordHeartbeat({
                    engineId: input.engineId,
                    orgId: engine.orgId,
                    publicKey: engine.publicKey,
                    rawBody: input.rawBody,
                    signatureHeader: input.signatureHeader,
                    receivedAt,
                });
    // Accepted heartbeats arrive every minute from every engine; only refusals are worth a log line.
    if (outcome.kind !== 'accepted') {
        deps.logger.warn('heartbeat.refused', { engineId: input.engineId, outcome: outcome.kind });
    }
    return outcome;
}
