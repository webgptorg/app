import type { EngineId } from '@ptbk/protocol';

import { cryptoRandom } from '../adapters/crypto-random';
import { newOrgId, newTeamId, type OrgId, type TeamId } from '../domain/ids';
import type { HeartbeatCounts } from '../domain/metering/usage-facts';
import { createMemoryMeteringStore } from './memory-metering-store';
import { describeMeteringStoreContract } from './metering-store-contract';
import { createTestEngine } from './test-engine';

describeMeteringStoreContract('memory', () => {
    const engines: {
        engineId: EngineId;
        orgId: OrgId;
        status: 'active' | 'suspended';
        createdAt: number;
        teamId: TeamId | null;
    }[] = [];
    const teams: { id: TeamId; orgId: OrgId; createdAt: number; deletedAt: number | null }[] = [];
    const teamMembers: { teamId: TeamId }[] = [];
    const memberships: { orgId: OrgId }[] = [];
    const engineDays: (HeartbeatCounts & { engineId: EngineId })[] = [];
    return {
        store: createMemoryMeteringStore({
            engines: () => engines,
            teams: () => teams,
            teamMembers: () => teamMembers,
            memberships: () => memberships,
            engineDays: () => engineDays,
        }),
        addOrg(people = 1) {
            const orgId = newOrgId(cryptoRandom);
            memberships.push(...Array.from({ length: people }, () => ({ orgId })));
            return Promise.resolve(orgId);
        },
        addTeam(orgId, { people = 0, deleted = false } = {}) {
            const id = newTeamId(cryptoRandom);
            teams.push({ id, orgId, createdAt: teams.length, deletedAt: deleted ? 1 : null });
            teamMembers.push(...Array.from({ length: people }, () => ({ teamId: id })));
            return Promise.resolve(id);
        },
        async addEngine(orgId, { teamId, status = 'active', createdAt = 0 } = {}) {
            const { engineId } = await createTestEngine();
            engines.push({ engineId, orgId, status, createdAt, teamId: teamId ?? null });
            return engineId;
        },
        addEngineDay(_orgId, engineId, day, counts) {
            engineDays.push({ engineId, day, ...counts });
            return Promise.resolve();
        },
    };
});
