import type { EngineId, Hostname } from '@ptbk/protocol';

import type { AdminAuditEntry } from '../auth/records';
import { newAdminAuditEntryId, type UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Random } from '../ports/random';

export type HostnameAuditAction =
    'engine.hostname.add' | 'engine.hostname.activate' | 'engine.hostname.deactivate' | 'engine.hostname.remove';

export const HOSTNAME_AUDIT_TARGET = 'engine-hostname';

/**
 * `admin_audit_log` has one target column, so it holds `<engineId>/<hostname>`: neither part can contain a slash, and
 * the pair stays readable after the row itself is gone.
 */
export function hostnameAuditEntry(
    deps: { readonly clock: Clock; readonly random: Random },
    adminUserId: UserId,
    action: HostnameAuditAction,
    engineId: EngineId,
    hostname: Hostname,
): AdminAuditEntry {
    return {
        id: newAdminAuditEntryId(deps.random),
        adminUserId,
        action,
        targetType: HOSTNAME_AUDIT_TARGET,
        targetId: `${engineId}/${hostname}`,
        reason: null,
        createdAt: deps.clock.nowMs(),
    };
}
