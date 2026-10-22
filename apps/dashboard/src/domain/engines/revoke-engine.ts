import type { EngineId } from '@ptbk/protocol';

import type { Actor } from '../authz/authorizer';
import { newOrgAuditEntryId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { Random } from '../ports/random';
import type { EngineStore, RevokeOutcome } from '../registration/engine-store';

export interface RevokeEngineDeps {
    readonly engines: Pick<EngineStore, 'revoke'>;
    readonly clock: Clock;
    readonly random: Random;
    readonly logger: Logger;
}

/**
 * The owner's answer to a compromised engine key (D-06): the engine ID is suspended for good, so relays drop it at
 * their next registry refresh and heartbeats and re-registration are refused. The actor was authorized for
 * `engine.revoke` on its own organization, which is the only one the store looks in.
 */
export async function revokeEngine(
    deps: RevokeEngineDeps,
    actor: Pick<Actor, 'orgId' | 'userId'>,
    engineId: EngineId,
): Promise<RevokeOutcome> {
    const outcome = await deps.engines.revoke(actor.orgId, engineId, {
        id: newOrgAuditEntryId(deps.random),
        actorUserId: actor.userId,
        at: deps.clock.nowMs(),
    });
    if (outcome === 'revoked') {
        deps.logger.info('engines.revoked', { engineId });
    }
    return outcome;
}
