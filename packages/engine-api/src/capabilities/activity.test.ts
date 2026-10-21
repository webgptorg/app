import { describe, expect, it } from 'vitest';

import { EngineEventReader } from '../events';
import { ACTIVITY_KINDS, Activity, ActivityPageReader, activityPermission, parseActivity } from './activity';
import { activitySample } from './fixtures/samples';

const SENTINEL = 'SENSITIVE-CONTENT-7f3a';

describe('parseActivity', () => {
    it.each(ACTIVITY_KINDS)('reads %s as known', (kind) => {
        const sample = activitySample(kind);
        expect(Activity.safeParse(sample).error).toBeUndefined();
        expect(parseActivity(sample)).toEqual({ kind: 'known', activity: sample });
    });

    it('reads a kind it does not know as unknown, keeping the raw item', () => {
        const raw = { ...activitySample('run.queued'), kind: 'deploy.started', environment: 'prod' };
        const parsed = parseActivity(raw);
        expect(parsed).toMatchObject({ kind: 'unknown', base: { kind: 'deploy.started', v: 1, id: 'activity-1' } });
        if (parsed.kind === 'unknown') {
            expect(parsed.raw).toBe(raw);
            expect(parsed.base).not.toHaveProperty('environment');
        }
    });

    it('reads a higher version of a known kind as unknown', () => {
        const raw = { ...activitySample('run.completed'), v: 2, usage: 'reshaped' };
        expect(parseActivity(raw)).toMatchObject({ kind: 'unknown', base: { kind: 'run.completed', v: 2 } });
    });

    it('reads a known kind with a broken payload as invalid, naming paths but not values', () => {
        const raw = { ...activitySample('run.failed'), runId: `bad id ${SENTINEL}`, error: { code: 42 } };
        const parsed = parseActivity(raw);
        expect(parsed).toMatchObject({ kind: 'invalid', base: { kind: 'run.failed', v: 1 } });
        if (parsed.kind !== 'invalid') throw new Error('expected invalid');
        expect(parsed.issues.map(({ path }) => path).sort()).toEqual(['error.code', 'error.summary', 'runId']);
        expect(JSON.stringify(parsed.issues)).not.toContain(SENTINEL);
    });

    it('reads a known kind missing a payload field as invalid', () => {
        const raw = activitySample('run.started');
        delete raw['runId'];
        expect(parseActivity(raw).kind).toBe('invalid');
    });

    it('strips fields a known kind does not declare', () => {
        const sample = activitySample('trigger.fired');
        const parsed = parseActivity({
            ...sample,
            summary: 'added later',
            actor: { kind: 'member', memberId: 'member-1', via: 'phone' },
        });
        expect(parsed).toEqual({ kind: 'known', activity: sample });
    });

    it.each([
        ['not an object', 'run.started'],
        ['null', null],
        ['no kind', { ...activitySample('run.started'), kind: undefined }],
        ['a kind without an area', { ...activitySample('run.started'), kind: 'started' }],
        ['v below 1', { ...activitySample('run.started'), v: 0 }],
        ['a bad id', { ...activitySample('run.started'), id: 'has spaces' }],
        ['a bad timestamp', { ...activitySample('run.started'), at: 'yesterday' }],
        ['an unknown actor kind', { ...activitySample('run.started'), actor: { kind: 'robot' } }],
        ['no agentId', { ...activitySample('run.started'), agentId: undefined }],
    ])('drops an item with %s', (_label, raw) => {
        const parsed = parseActivity(raw);
        expect(parsed.kind).toBe('dropped');
        if (parsed.kind === 'dropped') expect(parsed.issues.length).toBeGreaterThan(0);
    });
});

describe('activityPermission', () => {
    it.each([
        ['run.started', 'runs.read'],
        ['file.created', 'files.read'],
        ['trigger.fired', 'triggers.read'],
        ['integration.used', 'integrations.read'],
        ['member.joined', 'members.read'],
        ['engine.updated', 'security.read'],
        ['deploy.started', null],
        ['constructor.x', null],
        ['', null],
    ])('%s needs %s', (kind, permission) => {
        expect(activityPermission(kind)).toBe(permission);
    });

    it('maps every known kind to a permission', () => {
        for (const kind of ACTIVITY_KINDS) expect(activityPermission(kind), kind).not.toBeNull();
    });
});

describe('ActivityPageReader', () => {
    it('reads a page with one unknown, one invalid and one dropped item without failing', () => {
        const known = activitySample('run.started', 'activity-1');
        const page = ActivityPageReader.parse({
            items: [
                known,
                { ...activitySample('run.started', 'activity-2'), kind: 'deploy.started' },
                { ...activitySample('run.failed', 'activity-3'), error: 'boom' },
                { kind: 'run.started' },
            ],
            nextCursor: 'next',
            total: 4,
        });
        expect(page.dropped).toBe(1);
        expect(page.nextCursor).toBe('next');
        expect(page.items.map(({ kind }) => kind)).toEqual(['known', 'unknown', 'invalid']);
        expect(page.items[0]).toEqual({ kind: 'known', activity: known });
    });

    it('fails a broken envelope', () => {
        expect(ActivityPageReader.safeParse({ items: [] }).success).toBe(false);
        expect(ActivityPageReader.safeParse({ items: {}, nextCursor: null }).success).toBe(false);
        expect(ActivityPageReader.safeParse([]).success).toBe(false);
    });
});

describe('EngineEventReader', () => {
    it('skips event types it does not know', () => {
        expect(EngineEventReader.parse({ type: 'agent.teleported', agentId: 'agent-1' })).toBeNull();
        expect(EngineEventReader.parse({ agentId: 'agent-1' })).toBeNull();
        expect(EngineEventReader.parse('agent.changed')).toBeNull();
    });

    it('reads activity of an unknown kind as data', () => {
        const activity = { ...activitySample('run.started'), kind: 'deploy.started' };
        expect(EngineEventReader.parse({ type: 'activity', activity })).toMatchObject({
            type: 'activity',
            activity: { kind: 'unknown', base: { kind: 'deploy.started' } },
        });
    });

    it('reads known activity and skips activity without a valid base', () => {
        const activity = activitySample('file.created');
        expect(EngineEventReader.parse({ type: 'activity', activity })).toEqual({
            type: 'activity',
            activity: { kind: 'known', activity },
        });
        expect(EngineEventReader.parse({ type: 'activity', activity: { kind: 'run.started' } })).toBeNull();
        expect(EngineEventReader.parse({ type: 'activity' })).toBeNull();
    });

    it('strips unknown fields of known events', () => {
        expect(
            EngineEventReader.parse({
                type: 'run.changed',
                runId: 'run-1',
                agentId: 'agent-1',
                status: 'running',
                progress: 0.5,
            }),
        ).toEqual({ type: 'run.changed', runId: 'run-1', agentId: 'agent-1', status: 'running' });
    });

    it('fails a known event that breaks its schema', () => {
        const result = EngineEventReader.safeParse({ type: 'run.changed', runId: 'run-1', status: 'running' });
        expect(result.success).toBe(false);
        expect(result.error?.issues.map(({ path }) => path.join('.'))).toEqual(['agentId']);
    });

    it('reads a run status a newer engine added as unknown', () => {
        expect(
            EngineEventReader.parse({ type: 'run.changed', runId: 'run-1', agentId: 'agent-1', status: 'paused' }),
        ).toEqual({ type: 'run.changed', runId: 'run-1', agentId: 'agent-1', status: 'unknown' });
    });
});
