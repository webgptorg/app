import type { EngineId } from '@ptbk/protocol';

import { cryptoRandom } from '../adapters/crypto-random';
import { newOrgId, newTeamId } from '../domain/ids';
import type { OrgUsageFacts } from '../domain/metering/usage-facts';
import { usageDaySchema } from '../domain/usage/usage-day';
import { presenceEngineIds } from './relay-presence-store-contract';

/**
 * One organization of every edge: a project that reported, one whose team is gone and that never sent a heartbeat,
 * one not bound to a team yet, and a team without a project.
 */
export function testFacts() {
    const [reporting, silent, unbound] = presenceEngineIds(3);
    const teams = {
        reporting: newTeamId(cryptoRandom),
        empty: newTeamId(cryptoRandom),
        deleted: newTeamId(cryptoRandom),
    };
    const engines = { reporting: reporting as EngineId, silent: silent as EngineId, unbound: unbound as EngineId };
    const facts: OrgUsageFacts = {
        orgId: newOrgId(cryptoRandom),
        projects: [
            {
                engineId: engines.reporting,
                teamId: teams.reporting,
                heartbeat: { agents: 5, members: 2, day: usageDaySchema.parse('2027-01-15') },
            },
            { engineId: engines.silent, teamId: teams.deleted, heartbeat: null },
            { engineId: engines.unbound, teamId: null, heartbeat: null },
        ],
        teams: [
            { teamId: teams.reporting, people: 3 },
            { teamId: teams.empty, people: 0 },
        ],
        people: 4,
    };
    return { facts, engines, teams };
}
