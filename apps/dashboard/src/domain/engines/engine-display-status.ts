import type { EngineRecord } from '../registration/engine-store';
import type { EngineStatusSnapshot } from '../status/engine-status';

/**
 * What the engine list shows; `unknown` when the engine's status object did not answer in time. `owner-pending` is an
 * online engine whose heartbeat counts no member yet: nobody has created the owner's passkey on the engine (M-08).
 * `setup-pending` is an online engine with an owner whose setup is still a draft on the engine (D-36).
 */
export type EngineDisplayStatus =
    'suspended' | 'never-seen' | 'owner-pending' | 'setup-pending' | 'online' | 'offline' | 'unknown';

/** Our suspension wins over whatever the heartbeats say: relays no longer route a suspended engine. */
export function deriveEngineDisplayStatus(
    engine: Pick<EngineRecord, 'status'>,
    snapshot: EngineStatusSnapshot | null,
): EngineDisplayStatus {
    switch (engine.status) {
        case 'suspended':
            return 'suspended';
        case 'active':
            if (snapshot === null) {
                return 'unknown';
            }
            if (snapshot.state !== 'online' || snapshot.payload === null) {
                return snapshot.state;
            }
            // The owner's passkey comes first: until it exists, finishing setup is not what the engine asks for.
            if (snapshot.payload.members === 0) {
                return 'owner-pending';
            }
            return snapshot.payload.setup === 'pending' ? 'setup-pending' : 'online';
    }
}
