import type { Ed25519PublicKey, EngineId } from '@ptbk/protocol';

import type { EngineStatus } from '../registration/engine-store';

/** What a relay may learn about an engine: routing data, nothing about its organization, users or billing. */
export interface RegistryRecord {
    readonly publicKey: Ed25519PublicKey;
    readonly status: EngineStatus;
}

/**
 * The registry's read of `engines`. Relays are platform actors, so this read is not scoped by organization, which is
 * why it is a port of its own rather than an `EngineStore` method.
 */
export interface RegistryReader {
    findEngine(engineId: EngineId): Promise<RegistryRecord | null>;
}
