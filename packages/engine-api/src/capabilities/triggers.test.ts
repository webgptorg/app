import { describe, expect, it } from 'vitest';

import { Trigger, TriggerFirePageReader, TriggerPageReader, TriggerReader, TriggerStats } from './triggers';

const NOW = '2026-10-21T08:00:00.000Z';

const base = {
    id: 'trigger-1',
    agentId: 'agent-a',
    agentName: 'Ada',
    name: 'Morning summary',
    lifecycle: 'active',
    endedReason: null,
    lastFiredAt: null,
    nextFireAt: NOW,
    createdBy: 'member-owner',
    createdAt: NOW,
    updatedAt: NOW,
};

const schedule = {
    ...base,
    kind: 'schedule',
    config: {
        recurrence: { kind: 'cron', expression: '0 8 * * 1-5', timeZone: 'Europe/Prague' },
        startsAt: NOW,
        endsAt: null,
        maxRunCount: null,
        runCount: 0,
        message: 'Summarise the inbox.',
    },
};

describe('Trigger (API 1.7)', () => {
    it('names the agent, or null when the engine no longer knows it', () => {
        expect(Trigger.safeParse(schedule).success).toBe(true);
        expect(Trigger.safeParse({ ...schedule, agentName: null }).success).toBe(true);
        expect(Trigger.safeParse({ ...schedule, agentName: '' }).success).toBe(false);
        expect(Trigger.safeParse({ ...schedule, agentName: undefined }).success).toBe(false);
    });
});

describe('TriggerReader', () => {
    it('reads known triggers like the strict schema, keeps the raw lifecycle and strips unknown fields', () => {
        const read = TriggerReader.parse({ ...schedule, extra: 1, config: { ...schedule.config, extra: 2 } });
        expect(read).toEqual({ ...Trigger.parse(schedule), rawLifecycle: 'active' });
    });

    it('reads a kind a newer engine added as unknown, without its config', () => {
        const read = TriggerReader.parse({ ...base, kind: 'rss', config: { feed: 'https://example.com/feed' } });
        expect(read).toMatchObject({ kind: 'unknown', rawKind: 'rss', name: 'Morning summary' });
        expect(read).not.toHaveProperty('config');
    });

    it('reads an unknown lifecycle, ended reason and recurrence as unknown, keeping the raw lifecycle', () => {
        const read = TriggerReader.parse({
            ...schedule,
            lifecycle: 'snoozed',
            endedReason: 'quota',
            config: { ...schedule.config, recurrence: { kind: 'rrule', rule: 'FREQ=DAILY' } },
        });
        expect(read).toMatchObject({ lifecycle: 'unknown', rawLifecycle: 'snoozed', endedReason: 'unknown' });
        expect(read.kind === 'schedule' && read.config.recurrence).toEqual({ kind: 'unknown', rawKind: 'rrule' });
    });

    it('still refuses what breaks a known field', () => {
        expect(TriggerReader.safeParse({ ...schedule, name: '' }).success).toBe(false);
        expect(TriggerReader.safeParse({ ...base, kind: 'email', config: { address: 'not an address' } }).success).toBe(
            false,
        );
        expect(TriggerReader.safeParse({ ...schedule, lifecycle: 'x'.repeat(65) }).success).toBe(false);
        expect(TriggerReader.safeParse({ ...base, kind: 'x'.repeat(65) }).success).toBe(false);
        expect(TriggerReader.safeParse('trigger').success).toBe(false);
    });

    it('reads pages of triggers and fires tolerantly', () => {
        const page = TriggerPageReader.parse({ items: [{ ...base, kind: 'rss' }, schedule], nextCursor: null });
        expect(page.items.map((item) => item.kind)).toEqual(['unknown', 'schedule']);
        const fires = TriggerFirePageReader.parse({
            items: [{ id: 'fire-1', at: NOW, outcome: 'deferred', runId: null, error: null, extra: true }],
            nextCursor: 'next',
        });
        expect(fires.items[0]).toEqual({ id: 'fire-1', at: NOW, outcome: 'unknown', runId: null, error: null });
    });
});

describe('TriggerStats', () => {
    it('counts each known lifecycle and names the soonest fire', () => {
        const stats = { active: 2, paused: 1, failed: 0, ended: 3, nextFireAt: NOW };
        expect(TriggerStats.parse(stats)).toEqual(stats);
        expect(TriggerStats.safeParse({ ...stats, nextFireAt: null }).success).toBe(true);
        expect(TriggerStats.safeParse({ ...stats, failed: -1 }).success).toBe(false);
        expect(TriggerStats.safeParse({ ...stats, snoozed: 1 }).success).toBe(false);
    });
});
