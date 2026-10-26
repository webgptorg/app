import type { EngineId } from '@ptbk/protocol';

import type { AdminAuditEntry } from '../auth/records';
import { newAdminAuditEntryId, type UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { Random } from '../ports/random';
import type { PlatformEngineStore, PlatformSuspendOutcome, PlatformUnsuspendOutcome } from './platform-engine-store';

export const SUSPEND_ACTION = 'admin.engine.suspend';
export const UNSUSPEND_ACTION = 'admin.engine.unsuspend';
export const ENGINE_AUDIT_TARGET = 'engine';

export interface SuspendEngineDeps {
    readonly platformEngines: Pick<PlatformEngineStore, 'suspend' | 'unsuspend'>;
    readonly clock: Clock;
    readonly random: Random;
    readonly logger: Logger;
}

export interface SuspensionInput {
    readonly engineId: EngineId;
    readonly adminUserId: UserId;
    /** Why, in the admin's words (a report or ticket reference); kept in the audit log, never shown to the owner. */
    readonly reason: string;
}

function auditEntry(deps: SuspendEngineDeps, action: string, input: SuspensionInput): AdminAuditEntry {
    return {
        id: newAdminAuditEntryId(deps.random),
        adminUserId: input.adminUserId,
        action,
        targetType: ENGINE_AUDIT_TARGET,
        targetId: input.engineId,
        reason: input.reason,
        createdAt: deps.clock.nowMs(),
    };
}

/**
 * A platform admin's takedown (I-05): relays close the engine's tunnel at their next registry refresh and refuse new
 * ones, heartbeats and re-registration are refused, and its custom hostnames leave the registry. The caller was
 * authorized for `admin.engine.suspend` with a fresh step-up.
 */
export async function suspendEngine(deps: SuspendEngineDeps, input: SuspensionInput): Promise<PlatformSuspendOutcome> {
    const outcome = await deps.platformEngines.suspend(input.engineId, auditEntry(deps, SUSPEND_ACTION, input));
    if (outcome === 'suspended') {
        deps.logger.info('engines.suspended', { engineId: input.engineId });
    }
    return outcome;
}

/** Lifts a platform suspension only; an engine its owner revoked stays revoked (D-06). */
export async function unsuspendEngine(
    deps: SuspendEngineDeps,
    input: SuspensionInput,
): Promise<PlatformUnsuspendOutcome> {
    const outcome = await deps.platformEngines.unsuspend(input.engineId, auditEntry(deps, UNSUSPEND_ACTION, input));
    if (outcome === 'unsuspended') {
        deps.logger.info('engines.unsuspended', { engineId: input.engineId });
    }
    return outcome;
}
