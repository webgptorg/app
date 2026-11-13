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
    const owners = current.map(() => [] as number[]);
    const assignment = new Map<number, number>();
    function match(engineIndex: number, visited: Set<number>): boolean {
        const engine = engines[engineIndex];
        if (engine === undefined) return false;
        for (const [grantIndex, grant] of current.entries()) {
            if (visited.has(grantIndex) || !fits(engine, grant)) continue;
            visited.add(grantIndex);
            const assigned = owners[grantIndex];
            if (assigned === undefined) continue;
            const limit = grant.capabilities.engineProjects;
            if (limit === null || assigned.length < limit) {
                assigned.push(engineIndex);
                assignment.set(engineIndex, grantIndex);
                return true;
            }
            for (const [slot, previous] of assigned.entries()) {
                if (match(previous, visited)) {
                    assigned[slot] = engineIndex;
                    assignment.set(engineIndex, grantIndex);
                    return true;
                }
            }
        }
        return false;
    }
    engines.forEach((_engine, index) => match(index, new Set()));
    const assignments: Record<string, string> = {};
    const warnings: CoverageWarning[] = [];
    engines.forEach((engine, index) => {
        const grantIndex = assignment.get(index);
        const grant = grantIndex === undefined ? undefined : current[grantIndex];
        if (grant === undefined) warnings.push({ engineId: engine.id, reason: 'not-covered' });
        else assignments[engine.id] = grant.id;
        if (DIMENSIONS.some((dimension) => engine.counts[dimension] === null)) {
            warnings.push({ engineId: engine.id, reason: 'usage-unknown' });
        }
    });
    return { assignments, warnings, blocking: false };
}
