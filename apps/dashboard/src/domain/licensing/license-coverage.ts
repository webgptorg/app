import type { EngineLicenseUsage, LicenseDimension, LicenseGrant } from './license-contract';

const DIMENSIONS: readonly LicenseDimension[] = [
    'specialists',
    'controllingUsers',
    'harnessInstances',
    'browserProfiles',
];
export interface CoverageWarning {
    readonly engineId: string;
    readonly reason: 'not-covered' | 'usage-unknown';
}
export interface LicenseCoverage {
    readonly assignments: Readonly<Record<string, string>>;
    readonly warnings: readonly CoverageWarning[];
    /** Licensing never decides authorization, registration, relay routing or task execution. */
    readonly blocking: false;
}
function fits(usage: EngineLicenseUsage, grant: LicenseGrant): boolean {
    return DIMENSIONS.every((dimension) => {
        const count = usage.counts[dimension];
        const limit = grant.capabilities[dimension];
        return count === null || limit === null || count <= limit;
    });
}
/** Capacity matching can reassign a small engine so that a larger one receives its only suitable grant. */
export function licenseCoverage(
    engines: readonly EngineLicenseUsage[],
    grants: readonly LicenseGrant[],
    now: number,
): LicenseCoverage {
    const current = grants.filter(
        (grant) =>
            Date.parse(grant.validFrom) <= now && (grant.validUntil === null || Date.parse(grant.validUntil) > now),
    );
    // Each grant with the engines it covers; engines are matched by identity, so no index can point at nothing.
    const slots = current.map((grant) => ({ grant, assigned: [] as EngineLicenseUsage[] }));
    const assignment = new Map<EngineLicenseUsage, LicenseGrant>();
    function match(engine: EngineLicenseUsage, visited: Set<LicenseGrant>): boolean {
        for (const { grant, assigned } of slots) {
            if (visited.has(grant) || !fits(engine, grant)) continue;
            visited.add(grant);
            const limit = grant.capabilities.engineProjects;
            if (limit === null || assigned.length < limit) {
                assigned.push(engine);
                assignment.set(engine, grant);
                return true;
            }
            for (const [slot, previous] of assigned.entries()) {
                if (match(previous, visited)) {
                    assigned[slot] = engine;
                    assignment.set(engine, grant);
                    return true;
                }
            }
        }
        return false;
    }
    for (const engine of engines) match(engine, new Set());
    const assignments: Record<string, string> = {};
    const warnings: CoverageWarning[] = [];
    for (const engine of engines) {
        const grant = assignment.get(engine);
        if (grant === undefined) warnings.push({ engineId: engine.id, reason: 'not-covered' });
        else assignments[engine.id] = grant.id;
        if (DIMENSIONS.some((dimension) => engine.counts[dimension] === null)) {
            warnings.push({ engineId: engine.id, reason: 'usage-unknown' });
        }
    }
    return { assignments, warnings, blocking: false };
}
