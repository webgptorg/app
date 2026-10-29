import type { EngineId } from '@ptbk/protocol';

import type { EngineLabel } from '../../shared/engine-label';
import type { Actor } from '../authz/authorizer';
import { newOrgAuditEntryId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { Random } from '../ports/random';
import type { EngineStore, RenameOutcome } from '../registration/engine-store';

export interface RenameEngineDeps {
    readonly engines: Pick<EngineStore, 'rename'>;
    readonly clock: Clock;
    readonly random: Random;
    readonly logger: Logger;
}

/**
 * Sets or clears the owner's own name for an engine (D-06). The actor was authorized for `engine.rename` on its own
 * organization, the only one the store looks in. The label is account metadata, so neither the log nor the audit entry
 * carries it.
 */
export async function renameEngine(
    deps: RenameEngineDeps,
    actor: Pick<Actor, 'orgId' | 'userId'>,
    engineId: EngineId,
    label: EngineLabel | null,
): Promise<RenameOutcome> {
    const outcome = await deps.engines.rename(actor.orgId, engineId, label, {
        id: newOrgAuditEntryId(deps.random),
        actorUserId: actor.userId,
        at: deps.clock.nowMs(),
    });
    if (outcome === 'renamed') {
        deps.logger.info('engines.renamed', { engineId });
    }
    return outcome;
}
