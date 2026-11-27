import type { Meter, MeterCount } from './meter';

const known = (value: number): MeterCount => ({ value, unreported: 0 });

/** The people the dashboard added: the organization's members, and each team's (its project's). */
export const peopleMeter: Meter = {
    id: 'people',
    quotas: { org: 'people.max', project: null },
    createdBy: 'dashboard',
    measure(facts) {
        const teamPeople = new Map(facts.teams.map((team) => [team.teamId, team.people]));
        return {
            org: known(facts.people),
            teams: facts.teams.map((team) => ({ teamId: team.teamId, ...known(team.people) })),
            projects: facts.projects.map((project) => {
                const people = project.teamId === null ? undefined : teamPeople.get(project.teamId);
                return {
                    engineId: project.engineId,
                    ...(people === undefined ? { value: 0, unreported: 1 } : known(people)),
                };
            }),
        };
    },
};
