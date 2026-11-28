import type { EngineId } from '@ptbk/protocol';

import type { MeterId } from '../../shared/metering';
import type { Entitlements } from '../billing/entitlements';
import type { OrgId } from '../ids';
import { METER_REGISTRY } from './meters';
import type { MeteringStore } from './metering-store';

export interface MeterShortfall {
    readonly meter: MeterId;
    readonly scope: 'org' | 'project';
    /** The known count before the action, with what is pending. */
    readonly used: number;
    readonly limit: number;
}

/** What the upgrade flow is shown (ADR 0025): `block` refuses the action, `warn` lets it through and says so. */
export type MeterLimitCheck = { readonly outcome: 'ok' } | ({ readonly outcome: 'warn' | 'block' } & MeterShortfall);

export interface MeterLimitRequest {
    readonly meter: MeterId;
    /** How many the action adds. */
    readonly adding: number;
    /** The project it adds to, for a per-project quota; absent for something new to the organization. */
    readonly engineId?: EngineId;
    /** Promised to the organization but not in its facts yet, such as pending invitations: counted as used. */
    readonly pending?: number;
}

export interface MeterLimitDeps {
    readonly entitlements: Entitlements;
    readonly store: Pick<MeteringStore, 'readOrgFacts'>;
    /** Told of every shortfall before it is answered (D-41's `plan-limit`); it must not throw. */
    readonly onLimit?: (orgId: OrgId, shortfall: MeterLimitCheck & MeterShortfall) => Promise<void>;
}

/**
 * Asked only when the dashboard is about to create something; never of running work, an issued link code, a
 * heartbeat or access. An unreported count never makes a shortfall: its known part has to exceed the limit alone.
 */
export async function checkMeterLimit(
    deps: MeterLimitDeps,
    orgId: OrgId,
    request: MeterLimitRequest,
    signal: AbortSignal,
): Promise<MeterLimitCheck> {
    const meter = METER_REGISTRY[request.meter];
    const reading = meter.measure(await deps.store.readOrgFacts(orgId));
    const project =
        request.engineId === undefined ? undefined : reading.projects.find((p) => p.engineId === request.engineId);
    const candidates = [
        { scope: 'org' as const, quota: meter.quotas.org, used: reading.org.value + (request.pending ?? 0) },
        ...(project === undefined
            ? []
            : [{ scope: 'project' as const, quota: meter.quotas.project, used: project.value }]),
    ];
    for (const { scope, quota, used } of candidates) {
        if (quota === null) {
            continue;
        }
        const limit = await deps.entitlements.limit(orgId, quota, signal);
        if (limit !== null && used + request.adding > limit) {
            const blocks =
                meter.createdBy === 'dashboard' && (await deps.entitlements.overLimit(orgId, signal)) === 'block';
            const shortfall = { outcome: blocks ? 'block' : 'warn', meter: request.meter, scope, used, limit } as const;
            await deps.onLimit?.(orgId, shortfall);
            return shortfall;
        }
    }
    return { outcome: 'ok' };
}
