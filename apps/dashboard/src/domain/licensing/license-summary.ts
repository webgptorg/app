import type { EngineLicenseUsage, LicenseGrant, LicenseRead } from './license-contract';
import { licenseCoverage } from './license-coverage';

/** What the App knows itself. Specialists, harness instances and browser profiles stay unknown until engines report them. */
export interface OrgLicenseUsage {
    readonly engines: number;
    /** The organization's people; each engine's controlling users are at most these. */
    readonly people: number;
}

/** Advisory only (ADR 0021): a notice never blocks creating, linking or controlling an engine. */
export type LicenseNotice = 'unlinked' | 'missing' | 'expired' | 'exceeded';

export interface LicenseSummaryGrant extends LicenseGrant {
    readonly active: boolean;
}

export interface LicenseSummary {
    /** `stale`: the website did not answer, this is the last snapshot; `unknown`: there is none to show. */
    readonly state: 'current' | 'stale' | 'unknown';
    /** When the website generated the snapshot shown. */
    readonly checkedAt: string | null;
    readonly manageUrl: string | null;
    readonly grants: readonly LicenseSummaryGrant[];
    readonly coverage: {
        readonly engines: { readonly used: number; readonly covered: number; readonly capacity: number | null };
        /** The largest per-engine allowance among active grants; null is unlimited. */
        readonly people: { readonly used: number; readonly limit: number | null };
    } | null;
    readonly notice: LicenseNotice | null;
}

function isActive(grant: LicenseGrant, now: number): boolean {
    return Date.parse(grant.validFrom) <= now && (grant.validUntil === null || Date.parse(grant.validUntil) > now);
}

/** Null when any grant is unlimited; summing would otherwise turn unlimited into a number. */
function total(values: readonly (number | null)[], combine: (a: number, b: number) => number): number | null {
    return values.reduce<number | null>(
        (sum, value) => (sum === null || value === null ? null : combine(sum, value)),
        0,
    );
}

/** One synthetic usage per engine: the App knows how many engines there are, and nothing per engine beyond people. */
function engineUsages(usage: OrgLicenseUsage): EngineLicenseUsage[] {
    return Array.from({ length: usage.engines }, (_, index) => ({
        id: String(index),
        counts: { specialists: null, controllingUsers: usage.people, harnessInstances: null, browserProfiles: null },
    }));
}

export function summarizeLicense(input: {
    readonly linked: boolean;
    readonly read: LicenseRead;
    readonly usage: OrgLicenseUsage;
    readonly now: number;
}): LicenseSummary {
    const { read, usage, now } = input;
    if (read.kind === 'unknown') {
        return {
            state: 'unknown',
            checkedAt: null,
            manageUrl: null,
            grants: [],
            coverage: null,
            notice: input.linked ? null : 'unlinked',
        };
    }
    const { snapshot } = read;
    const grants = snapshot.grants.map((grant) => ({ ...grant, active: isActive(grant, now) }));
    const active = grants.filter((grant) => grant.active);
    const coverage = licenseCoverage(engineUsages(usage), active, now);
    const covered = Object.keys(coverage.assignments).length;
    let notice: LicenseNotice | null = null;
    if (usage.engines > 0 && active.length === 0) {
        notice = grants.some((grant) => grant.validUntil !== null && Date.parse(grant.validUntil) <= now)
            ? 'expired'
            : 'missing';
    } else if (covered < usage.engines) {
        notice = 'exceeded';
    }
    return {
        state: read.kind,
        checkedAt: snapshot.generatedAt,
        manageUrl: snapshot.manageUrl,
        grants,
        coverage: {
            engines: {
                used: usage.engines,
                covered,
                capacity: total(
                    active.map((grant) => grant.capabilities.engineProjects),
                    (a, b) => a + b,
                ),
            },
            people: {
                used: usage.people,
                limit: total(
                    active.map((grant) => grant.capabilities.controllingUsers),
                    Math.max,
                ),
            },
        },
        notice,
    };
}
