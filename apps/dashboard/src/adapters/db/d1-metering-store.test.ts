import { EngineVersion } from '@ptbk/protocol';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { cryptoRandom } from '../crypto-random';
import { newOrgId, newTeamId, newUserId, type OrgId, type UserId } from '../../domain/ids';
import { usageDaySchema } from '../../domain/usage/usage-day';
import { describeMeteringStoreContract } from '../../testing/metering-store-contract';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { createDatabase } from './client';
import { createD1MeteringStore } from './d1-metering-store';
import {
    engines,
    memberships,
    organizations,
    teamMembers,
    teams,
    usageDailyEngines,
    usageDailyMeters,
    users,
} from './schema';

const db = createDatabase(env.DB);
const people = new Map<OrgId, UserId[]>();
let teamCount = 0;

async function addOrg(count = 1): Promise<OrgId> {
    const orgId = newOrgId(cryptoRandom);
    await db.insert(organizations).values({ id: orgId, kind: 'team', name: null, createdAt: 0 });
    const userIds = Array.from({ length: count }, () => newUserId(cryptoRandom));
    for (const userId of userIds) {
        await db.batch([
            db.insert(users).values({ id: userId, email: `${userId}@ptbk.test`, createdAt: 0 }),
            db.insert(memberships).values({ orgId, userId, role: 'member', createdAt: 0 }),
        ]);
    }
    people.set(orgId, userIds);
    return orgId;
}

describeMeteringStoreContract('D1', () => ({
    store: createD1MeteringStore(db),
    addOrg,
    async addTeam(orgId, { people: count = 0, deleted = false } = {}) {
        const id = newTeamId(cryptoRandom);
        await db
            .insert(teams)
            .values({ id, orgId, name: 'Team', createdAt: teamCount++, deletedAt: deleted ? 1 : null });
        for (const userId of (people.get(orgId) ?? []).slice(0, count)) {
            await db.insert(teamMembers).values({ teamId: id, userId, createdAt: 0 });
        }
        return id;
    },
    async addEngine(orgId, { teamId, status = 'active', createdAt = 0 } = {}) {
        const row = engineRecord(await createTestEngine(), orgId, { status, createdAt });
        await db.insert(engines).values({ ...row, teamId: teamId ?? null });
        return row.engineId;
    },
    async addEngineDay(orgId, engineId, day, counts) {
        await db.insert(usageDailyEngines).values({
            day,
            engineId,
            orgId,
            beats: 1,
            firstBeatAt: 0,
            lastBeatAt: 0,
            engineVersion: EngineVersion.parse('1.0.0'),
            ...counts,
            setup: null,
            updateState: 'none',
            cpuLoad: 'low',
        });
    },
}));

it('deletes an organization’s meter days with it', async () => {
    const orgId = await addOrg(0);
    const day = usageDaySchema.parse('2027-01-15');
    await createD1MeteringStore(db).upsertMeterDays([
        { day, orgId, scope: 'org', scopeId: orgId, meter: 'projects', value: 0, unreported: 0 },
    ]);
    await db.delete(organizations).where(eq(organizations.id, orgId));
    expect(await db.select().from(usageDailyMeters).where(eq(usageDailyMeters.orgId, orgId))).toEqual([]);
});
