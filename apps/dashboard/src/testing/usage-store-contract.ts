import { EngineVersion, type EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { newUsageEventId, type OrgId, type UserId } from '../domain/ids';
import { cryptoRandom } from '../adapters/crypto-random';
import type { EngineDay } from '../domain/usage/engine-activity';
import { usageDaySchema } from '../domain/usage/usage-day';
import type { UsageEventRow } from '../domain/usage/usage-event';
import type { ActiveEngine, UsageStore } from '../domain/usage/usage-store';

/** 2027-01-15T00:00:00Z. */
const DAY_START = Date.UTC(2027, 0, 15);
const HOUR_MS = 60 * 60 * 1000;
const DAY = usageDaySchema.parse('2027-01-15');
const DAY_BEFORE = usageDaySchema.parse('2027-01-14');

export interface UsageStoreFixture {
    readonly store: UsageStore;
    /** A user with a personal organization and one session, last used at `lastSeenAt`. */
    addAccount(lastSeenAt?: number): Promise<{ readonly orgId: OrgId; readonly userId: UserId }>;
    addEngine(orgId: OrgId, status?: 'active' | 'suspended'): Promise<EngineId>;
    events(): Promise<readonly UsageEventRow[]>;
    engineDays(): Promise<readonly (EngineDay & ActiveEngine)[]>;
    /** `day|orgId|userId`, sorted. */
    people(): Promise<readonly string[]>;
}

function event(orgId: OrgId, overrides: Partial<UsageEventRow> = {}): UsageEventRow {
    return {
        id: newUsageEventId(cryptoRandom),
        occurredAt: DAY_START,
        event: 'org.created',
        orgId,
        userId: null,
        engineId: null,
        props: '{"kind":"personal"}',
        ...overrides,
    };
}

function engineDay(engine: ActiveEngine, overrides: Partial<EngineDay> = {}): EngineDay & ActiveEngine {
    return {
        ...engine,
        day: DAY,
        beats: 10,
        firstBeatAt: DAY_START + HOUR_MS,
        lastBeatAt: DAY_START + 2 * HOUR_MS,
        engineVersion: EngineVersion.parse('1.0.0'),
        agents: 2,
        members: 1,
        setup: 'pending',
        updateState: 'none',
        cpuLoad: 'low',
        ...overrides,
    };
}

/** The {@link UsageStore} contract, run against D1 and the in-memory store. */
export function describeUsageStoreContract(name: string, makeFixture: () => UsageStoreFixture): void {
    describe(`UsageStore contract: ${name}`, () => {
        let t: UsageStoreFixture;

        beforeEach(() => {
            t = makeFixture();
        });

        it('keeps events as given, once per ID', async () => {
            const { orgId, userId } = await t.addAccount();
            const rows = Array.from({ length: 20 }, (_, index) =>
                event(orgId, { userId, occurredAt: DAY_START + index }),
            );
            await t.store.insertEvents(rows);
            await t.store.insertEvents([rows[0] as UsageEventRow]);
            await t.store.insertEvents([]);
            const stored = (await t.events()).filter((row) => row.orgId === orgId);
            expect([...stored].sort((a, b) => a.occurredAt - b.occurredAt)).toEqual(rows);
        });

        it('lists the active engines only', async () => {
            const { orgId } = await t.addAccount();
            const active = await t.addEngine(orgId);
            const suspended = await t.addEngine(orgId, 'suspended');
            const listed = await t.store.listActiveEngines();
            expect(listed).toContainEqual({ engineId: active, orgId });
            expect(listed.map((engine) => engine.engineId)).not.toContain(suspended);
        });

        it('replaces an engine’s day on every write, so a repeated run changes nothing', async () => {
            const { orgId } = await t.addAccount();
            const engine = { engineId: await t.addEngine(orgId), orgId };
            const rows = Array.from({ length: 9 }, (_, index) =>
                engineDay(engine, { day: usageDaySchema.parse(`2027-01-${String(index + 1).padStart(2, '0')}`) }),
            );
            await t.store.upsertEngineDays(rows);
            await t.store.upsertEngineDays([engineDay(engine, { beats: 11, setup: 'done', agents: 3 })]);
            await t.store.upsertEngineDays([engineDay(engine, { beats: 11, setup: 'done', agents: 3 })]);
            await t.store.upsertEngineDays([]);
            const days = (await t.engineDays()).filter((row) => row.engineId === engine.engineId);
            expect(days).toHaveLength(10);
            expect(days.find((row) => row.day === DAY)).toEqual(
                engineDay(engine, { beats: 11, setup: 'done', agents: 3 }),
            );
        });

        it('counts a person on the day their session was last used, once', async () => {
            const early = await t.addAccount(DAY_START);
            const late = await t.addAccount(DAY_START + 24 * HOUR_MS - 1);
            const before = await t.addAccount(DAY_START - 1);
            const after = await t.addAccount(DAY_START + 24 * HOUR_MS);
            await t.store.rollUpPeople(DAY);
            await t.store.rollUpPeople(DAY);
            await t.store.rollUpPeople(DAY_BEFORE);
            const people = await t.people();
            expect(people).toContain(`${DAY}|${early.orgId}|${early.userId}`);
            expect(people).toContain(`${DAY}|${late.orgId}|${late.userId}`);
            expect(people).toContain(`${DAY_BEFORE}|${before.orgId}|${before.userId}`);
            const mine = [early, late, before, after].map((account) => account.userId as string);
            expect(people.filter((row) => mine.includes(row.split('|')[2] ?? ''))).toHaveLength(3);
        });

        it('prunes events and days before the cutoffs and keeps the rest', async () => {
            const { orgId, userId } = await t.addAccount(DAY_START - 1);
            const engine = { engineId: await t.addEngine(orgId), orgId };
            const old = event(orgId, { occurredAt: DAY_START - 1 });
            const kept = event(orgId, { occurredAt: DAY_START });
            await t.store.insertEvents([old, kept]);
            await t.store.upsertEngineDays([engineDay(engine, { day: DAY_BEFORE }), engineDay(engine)]);
            await t.store.rollUpPeople(DAY_BEFORE);
            await t.store.prune({ eventsBefore: DAY_START, daysBefore: DAY });
            const ids = (await t.events()).map((row) => row.id);
            expect(ids).toContain(kept.id);
            expect(ids).not.toContain(old.id);
            const days = (await t.engineDays()).filter((row) => row.engineId === engine.engineId);
            expect(days.map((row) => row.day)).toEqual([DAY]);
            expect((await t.people()).some((row) => row.endsWith(`|${userId}`))).toBe(false);
        });
    });
}
