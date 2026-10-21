import type { Bytes, Ed25519PublicKey, EngineId, HeartbeatVerification } from '@ptbk/protocol';

import type { OrgId } from '../ids';
import type { EngineStatusSnapshot } from './engine-status';

export interface RecordHeartbeatInput {
    readonly engineId: EngineId;
    /** From the engine's D1 row, so the alarm never looks up whom the engine belongs to. */
    readonly orgId: OrgId;
    readonly publicKey: Ed25519PublicKey;
    /** The body exactly as received; parsed only after its signature verifies. */
    readonly rawBody: Bytes;
    readonly signatureHeader: string | null;
    /** The Worker's clock when the request arrived: the `now` of C-03's timestamp check. */
    readonly receivedAt: number;
}

/** The per-engine status objects, addressed by engine ID (one Durable Object each in production). */
export interface EngineStatusDirectory {
    recordHeartbeat(input: RecordHeartbeatInput): Promise<HeartbeatVerification>;
    getStatus(engineId: EngineId): Promise<EngineStatusSnapshot>;
    /** Forgets the engine entirely, for engine removal. */
    reset(engineId: EngineId): Promise<void>;
}
