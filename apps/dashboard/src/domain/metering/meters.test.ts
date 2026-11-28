import { describe, expect, it } from 'vitest';

import { METERS } from '../../shared/metering';
import { testFacts } from '../../testing/test-metering';
import { measureAll, METER_REGISTRY } from './meters';

const { facts, engines, teams } = testFacts();

describe('meters', () => {
    it('has exactly one meter per ID', () => {
        expect(Object.keys(METER_REGISTRY)).toEqual([...METERS]);
        for (const id of METERS) {
            expect(METER_REGISTRY[id].id).toBe(id);
        }
    });

    it('counts active projects per team and for the organization', () => {
        expect(measureAll(facts).projects).toEqual({
            org: { value: 3, unreported: 0 },
            teams: [
                { teamId: teams.reporting, value: 1, unreported: 0 },
                { teamId: teams.empty, value: 0, unreported: 0 },
            ],
            projects: [
                { engineId: engines.reporting, value: 1, unreported: 0 },
                { engineId: engines.silent, value: 1, unreported: 0 },
                { engineId: engines.unbound, value: 1, unreported: 0 },
            ],
        });
    });

    it('sums heartbeat agents, keeping a project without a heartbeat unreported rather than zero', () => {
        expect(measureAll(facts).agents).toEqual({
            org: { value: 5, unreported: 2 },
            teams: [
                { teamId: teams.reporting, value: 5, unreported: 0 },
                { teamId: teams.empty, value: 0, unreported: 0 },
            ],
            projects: [
                { engineId: engines.reporting, value: 5, unreported: 0 },
                { engineId: engines.silent, value: 0, unreported: 1 },
                { engineId: engines.unbound, value: 0, unreported: 1 },
            ],
        });
        expect(measureAll(facts).members.org).toEqual({ value: 2, unreported: 2 });
    });

    it('counts the dashboard’s people, per team and per project through its team', () => {
        expect(measureAll(facts).people).toEqual({
            org: { value: 4, unreported: 0 },
            teams: [
                { teamId: teams.reporting, value: 3, unreported: 0 },
                { teamId: teams.empty, value: 0, unreported: 0 },
            ],
            projects: [
                { engineId: engines.reporting, value: 3, unreported: 0 },
                // Its team was deleted, so nobody is known to be on it.
                { engineId: engines.silent, value: 0, unreported: 1 },
                { engineId: engines.unbound, value: 0, unreported: 1 },
            ],
        });
    });

    it('reads an organization without projects as zero, which is known', () => {
        const empty = measureAll({ orgId: facts.orgId, projects: [], teams: [], people: 1 });
        expect(empty.agents.org).toEqual({ value: 0, unreported: 0 });
        expect(empty.projects.org).toEqual({ value: 0, unreported: 0 });
        expect(empty.people.org).toEqual({ value: 1, unreported: 0 });
    });
});
