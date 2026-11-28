import type { Entitlements, MeterQuota, OverLimit } from '../domain/billing/entitlements';
import type { OrgId } from '../domain/ids';

export interface FakeEntitlementGrant {
    readonly enginesCreate: boolean;
    /** `null` is unlimited. */
    readonly enginesMax: number | null;
    /** Unlimited unless given. */
    readonly meterQuotas?: Readonly<Partial<Record<MeterQuota, number | null>>>;
    /** `block` unless given. */
    readonly overLimit?: OverLimit;
}

export interface FakeEntitlements extends Entitlements {
    /** Overrides the default grant for one organization. */
    grant(orgId: OrgId, grant: Partial<FakeEntitlementGrant>): void;
}

/** Entitlements without plans or a billing store, for tests of what they gate (ADR 0017). */
export function createFakeEntitlements(
    defaults: FakeEntitlementGrant = { enginesCreate: true, enginesMax: null },
): FakeEntitlements {
    const grants = new Map<OrgId, FakeEntitlementGrant>();
    const of = (orgId: OrgId) => grants.get(orgId) ?? defaults;
    return {
        // `engines.create` is the only feature so far.
        allows: (orgId) => Promise.resolve(of(orgId).enginesCreate),
        limit(orgId, quota) {
            const grant = of(orgId);
            if (quota === 'engines.max') {
                return Promise.resolve(grant.enginesMax);
            }
            return Promise.resolve(quota === 'custom-domains.max' ? 0 : (grant.meterQuotas?.[quota] ?? null));
        },
        overLimit: (orgId) => Promise.resolve(of(orgId).overLimit ?? 'block'),
        grant(orgId, grant) {
            grants.set(orgId, { ...of(orgId), ...grant });
        },
    };
}
