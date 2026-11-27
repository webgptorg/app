import { METERS, type MeterId } from '../../shared/metering';
import type { OverLimit } from '../../shared/billing';
import type { Entitlements } from '../billing/entitlements';
import type { OrgId } from '../ids';
import type { MeterReading } from './meter';
import { measureAll, METER_REGISTRY } from './meters';
import type { MeteringStore } from './metering-store';

export interface MeterUsage {
    readonly meter: MeterId;
    readonly reading: MeterReading;
    /** `null` is unlimited, and so is a scope the meter has no quota for. */
    readonly limits: { readonly org: number | null; readonly project: number | null };
}

export interface UsageOverview {
    readonly overLimit: OverLimit;
    readonly meters: readonly MeterUsage[];
}

/** Every meter's reading now, with the limits the organization's entitlements set for it. Read-only. */
export async function readUsageOverview(
    deps: { readonly entitlements: Entitlements; readonly store: Pick<MeteringStore, 'readOrgFacts'> },
    orgId: OrgId,
    signal: AbortSignal,
): Promise<UsageOverview> {
    const readings = measureAll(await deps.store.readOrgFacts(orgId));
    const limitOf = async (quota: Parameters<Entitlements['limit']>[1] | null) =>
        quota === null ? null : deps.entitlements.limit(orgId, quota, signal);
    const meters = await Promise.all(
        METERS.map(async (meter) => {
            const { quotas } = METER_REGISTRY[meter];
            const [org, project] = await Promise.all([limitOf(quotas.org), limitOf(quotas.project)]);
            return { meter, reading: readings[meter], limits: { org, project } };
        }),
    );
    return { overLimit: await deps.entitlements.overLimit(orgId, signal), meters };
}
