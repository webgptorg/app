import type { EngineId, Hostname } from '@ptbk/protocol';

import type { UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Random } from '../ports/random';
import type { CustomHostnameStore } from './custom-hostname-store';
import { hostnameAuditEntry } from './hostname-audit';

export interface RemoveCustomHostnameDeps {
    readonly customHostnames: Pick<CustomHostnameStore, 'remove'>;
    readonly clock: Clock;
    readonly random: Random;
}

/** Relays stop routing it within one registry cache TTL (5 minutes). */
export async function removeCustomHostname(
    deps: RemoveCustomHostnameDeps,
    input: { readonly engineId: EngineId; readonly hostname: Hostname; readonly adminUserId: UserId },
): Promise<{ readonly kind: 'removed' } | { readonly kind: 'not-found' }> {
    const audit = hostnameAuditEntry(deps, input.adminUserId, 'engine.hostname.remove', input.engineId, input.hostname);
    const outcome = await deps.customHostnames.remove(input.engineId, input.hostname, audit);
    return { kind: outcome };
}
