import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { cryptoRandom } from '../crypto-random';
import { newUsageEventId } from '../../domain/ids';
import { CpuLoad, EngineVersion, SetupState, UpdateState } from '@ptbk/protocol';
import { usageDaySchema } from '../../domain/usage/usage-day';
import { testAccount } from '../../testing/auth-store-contract';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { describeUsageStoreContract } from '../../testing/usage-store-contract';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1UsageStore } from './d1-usage-store';
import {
    engines,
    memberships,
    organizations,
    passkeys,
    sessions,
    usageDailyEngines,
    usageDailyPeople,
    usageEvents,
    users,
} from './schema';
import { EngineId } from '@ptbk/protocol';
import { orgIdSchema } from '../../domain/ids';

const db = createDatabase(env.DB);

async function addAccount(lastSeenAt = 0) {
    const account = testAccount();
    await createD1AuthStore(db).accounts.createAccount({
        ...account,
        session: { ...account.session, lastSeenAt },
    });
    return account;
}

describeUsageStoreContract('D1', () => ({
    store: createD1UsageStore(db),
    async addAccount(lastSeenAt) {
        const { orgId, userId } = await addAccount(lastSeenAt);
        return { orgId, userId };
    },
    async addEngine(orgId, status = 'active') {
        const row = engineRecord(await createTestEngine(), orgId, { status });
        await db.insert(engines).values(row);
        return row.engineId;
    },
    async events() {
        const rows = await db.select().from(usageEvents).all();
        return rows.map((row) => ({ ...row, event: row.event as 'org.created' }));
    },
    async engineDays() {
        const rows = await db.select().from(usageDailyEngines).all();
        return rows.map((row) => ({
            ...row,
            day: usageDaySchema.parse(row.day),
            engineId: EngineId.parse(row.engineId),
            orgId: orgIdSchema.parse(row.orgId),
            engineVersion: EngineVersion.parse(row.engineVersion),
            setup: row.setup === null ? null : SetupState.parse(row.setup),
            updateState: UpdateState.parse(row.updateState),
            cpuLoad: CpuLoad.parse(row.cpuLoad),
        }));
    },
    async people() {
        const rows = await db.select().from(usageDailyPeople).all();
        return rows.map((row) => `${row.day}|${row.orgId}|${row.userId}`).sort();
    },
}));

describe('usage rows when an account or organization goes', () => {
    async function seed() {
        const account = await addAccount(Date.UTC(2027, 0, 15, 12));
        const store = createD1UsageStore(db);
        const engine = engineRecord(await createTestEngine(), account.orgId);
        await db.insert(engines).values(engine);
        await store.insertEvents([
            {
                id: newUsageEventId(cryptoRandom),
                occurredAt: 1,
                event: 'account.signed_up',
                orgId: account.orgId,
                userId: account.userId,
                engineId: null,
                props: '{"via":"signup"}',
            },
        ]);
        await store.rollUpPeople(usageDaySchema.parse('2027-01-15'));
        return { account, engine };
    }

    it('keeps a deleted account’s events without its user ID and drops its daily rows', async () => {
        const { account } = await seed();
        await db.batch([
            db.delete(sessions).where(eq(sessions.userId, account.userId)),
            db.delete(passkeys).where(eq(passkeys.userId, account.userId)),
            db.delete(memberships).where(eq(memberships.userId, account.userId)),
            db.delete(users).where(eq(users.id, account.userId)),
        ]);
        const events = await db.select().from(usageEvents).where(eq(usageEvents.orgId, account.orgId)).all();
        expect(events.map((row) => row.userId)).toEqual([null]);
        expect(await db.select().from(usageDailyPeople).where(eq(usageDailyPeople.userId, account.userId))).toEqual([]);
    });

    it('deletes an organization’s rows with it', async () => {
        const { account, engine } = await seed();
        await createD1UsageStore(db).upsertEngineDays([
            {
                engineId: engine.engineId,
                orgId: account.orgId,
                day: usageDaySchema.parse('2027-01-15'),
                beats: 1,
                firstBeatAt: 1,
                lastBeatAt: 1,
                engineVersion: EngineVersion.parse('1.0.0'),
                agents: 0,
                members: 0,
                setup: null,
                updateState: 'none',
                cpuLoad: 'low',
            },
        ]);
        await db.batch([
            db.delete(engines).where(eq(engines.orgId, account.orgId)),
            db.delete(sessions).where(eq(sessions.userId, account.userId)),
            db.delete(memberships).where(eq(memberships.orgId, account.orgId)),
            db.delete(organizations).where(eq(organizations.id, account.orgId)),
        ]);
        for (const table of [usageEvents, usageDailyEngines, usageDailyPeople]) {
            expect(await db.select().from(table).where(eq(table.orgId, account.orgId))).toEqual([]);
        }
    });
});
