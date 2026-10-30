import type { Ed25519PublicKey, EngineId } from '@ptbk/protocol';

import type { EngineLabel } from '../../shared/engine-label';
import type { OrgId } from '../ids';
import type { EngineStatus } from '../registration/engine-store';

export interface HeartbeatEngine {
    readonly orgId: OrgId;
    readonly publicKey: Ed25519PublicKey;
    readonly status: EngineStatus;
    /** For the status emails' wording only; the owner's own name for it. */
    readonly label: EngineLabel | null;
}

/**
 * The heartbeat's read of `engines`. Unscoped like the registry's: the engine proves it holds the key by the signature
 * its object checks next, and nothing read here is answered to the caller.
 */
export interface HeartbeatEngineReader {
    findEngine(engineId: EngineId): Promise<HeartbeatEngine | null>;
}
