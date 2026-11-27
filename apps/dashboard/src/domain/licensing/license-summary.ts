import type { EngineLicenseUsage, LicenseGrant, LicenseRead, WebsiteLicenseStatus } from './license-contract';
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

/** When the licence shown ends, ended or starts; null when it has no end, or there is none. */
export interface LicenseTerm {
    readonly kind: 'ends' | 'ended' | 'starts';
    readonly at: string;
}

export interface LicenseSummary {
    /** `stale`: the website did not answer, this is the last snapshot; `unknown`: there is none to show. */
    readonly state: 'current' | 'stale' | 'unknown';
    /** Null while unknown. Recomputed from the grants at `now`, so a stale snapshot never shows an ended grant as active. */
    readonly status: WebsiteLicenseStatus | null;
    /** The website's own plan name, when its API sends one. */
    readonly label: string | null;
    readonly term: LicenseTerm | null;
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

/** The latest (`direction` 1) or earliest (-1) of ISO timestamps; undefined for none. */
function extreme(values: readonly string[], direction: 1 | -1): string | undefined {
    return values.reduce<string | undefined>(
        (best, value) => (best === undefined || (Date.parse(value) - Date.parse(best)) * direction > 0 ? value : best),
        undefined,
    );
}

/**
 * The grants decide, as of `now`; the website's word only adds what grants cannot say: that an active one is a trial,
 * or, as its lookup sends no past or future grants, that a licence has ended or is yet to start.
 */
function licenseStatus(
    grants: readonly LicenseSummaryGrant[],
    website: WebsiteLicenseStatus | null,
    now: number,
): { readonly status: WebsiteLicenseStatus; readonly term: LicenseTerm | null } {
    const active = grants.filter((grant) => grant.active);
    if (active.length > 0) {
        const ends = active.map((grant) => grant.validUntil);
        const until = ends.includes(null)
            ? undefined
            : extreme(
                  ends.filter((end) => end !== null),
                  1,
              );
        return {
            status: website === 'trial' ? 'trial' : 'active',
            term: until === undefined ? null : { kind: 'ends', at: until },
        };
    }
    const starts = extreme(
        grants.filter((grant) => Date.parse(grant.validFrom) > now).map((grant) => grant.validFrom),
        -1,
    );
    if (starts !== undefined) return { status: 'scheduled', term: { kind: 'starts', at: starts } };
    // Neither active nor future: every grant left has ended.
    const ended = extreme(
        grants.map((grant) => grant.validUntil).filter((end) => end !== null),
        1,
    );
    if (ended !== undefined) return { status: 'expired', term: { kind: 'ended', at: ended } };
    return { status: website === 'scheduled' || website === 'expired' ? website : 'none', term: null };
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
            status: null,
            label: null,
            term: null,
            checkedAt: null,
            manageUrl: null,
            grants: [],
            coverage: null,
            notice: input.linked ? null : 'unlinked',
        };
    }
    const { snapshot } = read.license;
    const grants = snapshot.grants.map((grant) => ({ ...grant, active: isActive(grant, now) }));
    const { status, term } = licenseStatus(grants, read.license.status, now);
    const active = grants.filter((grant) => grant.active);
    const coverage = licenseCoverage(engineUsages(usage), active, now);
    const covered = Object.keys(coverage.assignments).length;
    let notice: LicenseNotice | null = null;
    if (usage.engines > 0 && active.length === 0) {
        notice = status === 'expired' ? 'expired' : 'missing';
    } else if (covered < usage.engines) {
        notice = 'exceeded';
    }
    return {
        state: read.kind,
        status,
        label: read.license.label,
        term,
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
