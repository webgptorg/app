import type { EngineId } from '@ptbk/protocol';

import type { MeterQuota, Quota } from '../../shared/billing';
import type { MeterId } from '../../shared/metering';
import type { TeamId } from '../ids';
import type { OrgUsageFacts, ProjectFacts } from './usage-facts';

/** `value` counts what is known; `unreported` projects have not sent the count yet, so `value` is a lower bound. */
export interface MeterCount {
    readonly value: number;
    readonly unreported: number;
}

export interface MeterReading {
    readonly org: MeterCount;
    readonly teams: readonly (MeterCount & { readonly teamId: TeamId })[];
    readonly projects: readonly (MeterCount & { readonly engineId: EngineId })[];
}

/** One count billing can limit (ADR 0025): a pure function of what the dashboard knows. */
export interface Meter {
    readonly id: MeterId;
    readonly quotas: { readonly org: Quota | MeterQuota | null; readonly project: MeterQuota | null };
    /**
     * Who creates what it counts. The dashboard can stop only what it creates itself; what an engine creates can only
     * be reported, whatever the plan says.
     */
    readonly createdBy: 'dashboard' | 'engine';
    measure(facts: OrgUsageFacts): MeterReading;
}

export const ZERO: MeterCount = Object.freeze({ value: 0, unreported: 0 });

export function addCounts(counts: Iterable<MeterCount>): MeterCount {
    let value = 0;
    let unreported = 0;
    for (const count of counts) {
        value += count.value;
        unreported += count.unreported;
    }
    return { value, unreported };
}

/** A count per project, `null` while the project has not reported it; teams and the organization add theirs up. */
export function measureSummedPerProject(
    facts: OrgUsageFacts,
    count: (project: ProjectFacts) => number | null,
): MeterReading {
    const projects = facts.projects.map((project) => {
        const value = count(project);
        return {
            engineId: project.engineId,
            ...(value === null ? { value: 0, unreported: 1 } : { value, unreported: 0 }),
        };
    });
    const byTeam = (teamId: TeamId) =>
        addCounts(projects.filter((_, index) => facts.projects[index]?.teamId === teamId));
    return {
        org: addCounts(projects),
        teams: facts.teams.map(({ teamId }) => ({ teamId, ...byTeam(teamId) })),
        projects,
    };
}
