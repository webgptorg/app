import { expectedCnameTarget, type EngineId, type Hostname } from '@ptbk/protocol';

import type { UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { CnameLookup, DnsResolver } from '../ports/dns-resolver';
import type { Random } from '../ports/random';
import type { CustomHostnameRecord, CustomHostnameStatus, CustomHostnameStore } from './custom-hostname-store';
import { hostnameAuditEntry } from './hostname-audit';

export interface CheckCustomHostnameDeps {
    readonly customHostnames: Pick<CustomHostnameStore, 'find' | 'recordDnsCheck'>;
    readonly dns: DnsResolver;
    readonly clock: Clock;
    readonly random: Random;
    readonly engineDomain: Hostname;
}

export interface CheckCustomHostnameInput {
    readonly engineId: EngineId;
    readonly hostname: Hostname;
    readonly adminUserId: UserId;
}

export type CheckCustomHostnameOutcome =
    | { readonly kind: 'checked'; readonly record: CustomHostnameRecord; readonly lookup: CnameLookup }
    | { readonly kind: 'not-found' };

/**
 * Looks the hostname's CNAME up and sets the row to what it shows, with the relay's comparison: `active` exactly when
 * the target is the engine's default hostname (`expectedCnameTarget`), never a relay name. A definite answer that
 * no longer matches takes an active row back to `pending-dns`; a failed lookup (`error`) changes nothing, as it says
 * nothing about the record.
 */
export async function checkCustomHostname(
    deps: CheckCustomHostnameDeps,
    input: CheckCustomHostnameInput,
    signal: AbortSignal,
): Promise<CheckCustomHostnameOutcome> {
    const record = await deps.customHostnames.find(input.engineId, input.hostname);
    if (record === null) {
        return { kind: 'not-found' };
    }
    const lookup = await deps.dns.resolveCname(input.hostname, signal);
    if (lookup.kind === 'error') {
        return { kind: 'checked', record, lookup };
    }
    const expected = expectedCnameTarget(input.engineId, deps.engineDomain);
    const status: CustomHostnameStatus =
        lookup.kind === 'cname' && lookup.target === expected ? 'active' : 'pending-dns';
    const checkedAt = deps.clock.nowMs();
    const audit =
        status === record.status
            ? null
            : hostnameAuditEntry(
                  deps,
                  input.adminUserId,
                  status === 'active' ? 'engine.hostname.activate' : 'engine.hostname.deactivate',
                  input.engineId,
                  input.hostname,
              );
    const updated = await deps.customHostnames.recordDnsCheck(
        input.engineId,
        input.hostname,
        { status, checkedAt },
        audit,
    );
    return updated === 'updated'
        ? { kind: 'checked', record: { ...record, status, dnsCheckedAt: checkedAt }, lookup }
        : { kind: 'not-found' };
}
