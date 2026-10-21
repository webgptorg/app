import type { EngineRecord } from '../registration/engine-store';
import type { EngineStatusSnapshot } from '../status/engine-status';

/** What the engine list shows; `unknown` when the engine's status object did not answer in time. */
export type EngineDisplayStatus = 'suspended' | 'never-seen' | 'online' | 'offline' | 'unknown';

/** Our suspension wins over whatever the heartbeats say: relays no longer route a suspended engine. */
export function deriveEngineDisplayStatus(
    engine: Pick<EngineRecord, 'status'>,
    snapshot: EngineStatusSnapshot | null,
): EngineDisplayStatus {
    switch (engine.status) {
        case 'suspended':
            return 'suspended';
        case 'active':
            return snapshot === null ? 'unknown' : snapshot.state;
    }
}
