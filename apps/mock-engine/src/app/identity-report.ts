import type { Ed25519PublicKey, EngineId, Hostname } from '@ptbk/protocol';
import { defaultHostname, ed25519PublicKeyFromBytes } from '@ptbk/protocol';

import type { EngineIdentity } from '../domain/identity/engine-identity';

/** What the relay's static registry needs about this engine (X-01): public data only. */
export interface IdentityReport {
    readonly engineId: EngineId;
    readonly enginePublicKey: Ed25519PublicKey;
    readonly hostname: Hostname;
}

export function identityReport(identity: EngineIdentity, engineDomain: Hostname): IdentityReport {
    return Object.freeze({
        engineId: identity.engineId,
        enginePublicKey: ed25519PublicKeyFromBytes(identity.publicKey),
        hostname: defaultHostname(identity.engineId, engineDomain),
    });
}
