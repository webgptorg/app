import { describe, expect, it } from 'vitest';

import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import {
    MAX_NOTIFICATIONS_PER_SEEN,
    MarkNotificationsSeenBody,
    NotificationId,
    NotificationPageReader,
    NotificationReader,
} from '../capabilities/notifications';
import { createEngineApiClient } from '../client';
import type { EngineApiResponse } from '../client';
import { DEFAULT_CAPABILITIES, actorFromOptions, createInMemoryEngineCore } from '../in-memory-client';
import type { InMemoryEngineCoreOptions } from '../in-memory-client';
import { OWNER_PERMISSIONS, PERMISSIONS } from '../permissions';
import type { Permission } from '../permissions';
import { withClientReading } from '../reader';
import { MAX_ATTENTION_ENTRIES, defaultDashboardAttention } from './notifications';

const START = Date.parse('2026-11-27T08:00:00Z');
const signal = () => AbortSignal.timeout(5_000);
const MEMBER_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((permission) => permission !== 'settings.manage');

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

function codeOf(response: EngineApiResponse<unknown>): string {
    return response.kind === 'problem' ? response.problem.code : 'ok';
}

function member(id: string, dashboardUserId: string | null, status: 'active' | 'disabled' = 'active') {
    return {
        id,
        displayName: id,
        role: 'member' as const,
        status,
        createdAt: '2026-11-01T08:00:00Z',
        lastSeenAt: null,
        passkeyCount: 1,
        dashboardUserId,
    };
}

function setup(options: Partial<InMemoryEngineCoreOptions> = {}) {
    let nowMs = START;
    const core = createInMemoryEngineCore({
        clock: { now: () => new Date(nowMs) },
        seed: { members: [member('petr', 'dash-petr'), member('jana', null), member('eva', 'dash-eva', 'disabled')] },
        ...options,
    });
    const clientAs = (id: string, permissions: readonly Permission[] = MEMBER_PERMISSIONS, stepUp = true) =>
        createEngineApiClient(
            withClientReading(
                core.transport(
                    actorFromOptions({ member: { id, permissions }, stepUp: stepUp ? 'satisfied' : 'required' }),
                ),
            ),
        );
    return {
        core,
        owner: clientAs('member-owner', OWNER_PERMISSIONS),
        petr: clientAs('petr'),
        jana: clientAs('jana'),
        clientAs,
        advance: (ms: number) => {
            nowMs += ms;
        },
    };
}

describe('notifications@1 in the in-memory engine', () => {
    it('lists each member only their own open items, newest first, with their content', async () => {
        const { core, petr, jana, advance } = setup();
        const first = core.controller.raiseNotification({
            memberId: 'petr',
            kind: 'agent-waiting',
            title: 'Invoice bot asks which account to use',
            target: { kind: 'chat', agentId: 'invoice-bot', chatId: 'march' },
        });
        advance(1_000);
        const second = core.controller.raiseNotification({
            memberId: 'petr',
            kind: 'task-failed',
            title: 'Weekly report failed',
            detail: 'The spreadsheet was not found.',
            target: { kind: 'task', taskId: 'weekly-report' },
        });
        core.controller.raiseNotification({ memberId: 'jana', kind: 'agent-waiting', title: 'For Jana' });

        const listed = ok(await petr.notifications.list({}, signal())).items;
        expect(listed.map(({ id }) => id)).toEqual([second.id, first.id]);
        expect(listed[0]).toMatchObject({ audience: 'personal', detail: 'The spreadsheet was not found.' });
        expect(ok(await jana.notifications.list({}, signal())).items.map(({ title }) => title)).toEqual(['For Jana']);
    });

    it('counts unseen items per kind and lowers the count once they are seen, keeping the first seenAt', async () => {
        const { core, petr, advance } = setup();
        const a = core.controller.raiseNotification({ memberId: 'petr', kind: 'agent-waiting', title: 'A' });
        core.controller.raiseNotification({ memberId: 'petr', kind: 'agent-waiting', title: 'B' });
        core.controller.raiseNotification({ memberId: 'petr', kind: 'task-failed', title: 'C' });
        expect(ok(await petr.notifications.counts(signal()))).toEqual({
            total: 3,
            byKind: { 'agent-waiting': 2, 'task-failed': 1, 'tool-sign-in': 0 },
        });
        const after = ok(await petr.notifications.markSeen({ ids: [a.id, a.id] }, signal()));
        expect(after.byKind['agent-waiting']).toBe(1);
        const seenAt = ok(await petr.notifications.list({}, signal())).items.find(({ id }) => id === a.id)?.seenAt;
        expect(seenAt).not.toBeNull();
        advance(60_000);
        ok(await petr.notifications.markSeen({ ids: [a.id] }, signal()));
        expect(ok(await petr.notifications.list({}, signal())).items.find(({ id }) => id === a.id)?.seenAt).toBe(
            seenAt,
        );
    });

    it('refuses another person’s, an unknown or a closed item with 404 and marks none of the batch', async () => {
        const { core, petr, jana } = setup();
        const mine = core.controller.raiseNotification({ memberId: 'petr', kind: 'agent-waiting', title: 'Mine' });
        const theirs = core.controller.raiseNotification({ memberId: 'jana', kind: 'agent-waiting', title: 'Hers' });
        expect(codeOf(await petr.notifications.markSeen({ ids: [mine.id, theirs.id] }, signal()))).toBe('not-found');
        expect(
            codeOf(await petr.notifications.markSeen({ ids: [NotificationId.parse('no-such-item')] }, signal())),
        ).toBe('not-found');
        expect(ok(await petr.notifications.counts(signal())).total).toBe(1);
        expect(ok(await jana.notifications.counts(signal())).total).toBe(1);

        expect(core.controller.closeNotification(mine.id)).toBe(true);
        expect(core.controller.closeNotification(mine.id)).toBe(false);
        expect(core.controller.closeNotification('no-such-item')).toBe(false);
        expect(codeOf(await petr.notifications.markSeen({ ids: [mine.id] }, signal()))).toBe('not-found');
        expect(ok(await petr.notifications.list({}, signal())).items).toEqual([]);
    });

    it('shows project-wide items to managers only, seen for all of them once one has seen it', async () => {
        const { core, owner, petr, clientAs } = setup();
        const item = core.controller.raiseNotification({
            memberId: null,
            kind: 'tool-sign-in',
            title: 'Claude Code needs signing in again',
            target: { kind: 'ai-tool', aiToolId: 'claude-code' },
        });
        expect(ok(await petr.notifications.list({}, signal())).items).toEqual([]);
        expect(codeOf(await petr.notifications.markSeen({ ids: [item.id] }, signal()))).toBe('not-found');
        const admin = clientAs('jana', ['settings.manage']);
        expect(ok(await owner.notifications.list({}, signal())).items[0]).toMatchObject({ audience: 'project' });
        expect(ok(await admin.notifications.counts(signal())).byKind['tool-sign-in']).toBe(1);
        ok(await admin.notifications.markSeen({ ids: [item.id] }, signal()));
        expect(ok(await owner.notifications.counts(signal())).total).toBe(0);
    });

    it('refuses to raise an item for an unknown member', () => {
        const { core } = setup();
        expect(() =>
            core.controller.raiseNotification({ memberId: 'nobody', kind: 'task-failed', title: 'X' }),
        ).toThrow();
    });

    it('derives attention from unseen items of members who joined with a ticket, and project-wide ones', async () => {
        const { core, petr } = setup();
        const waiting = core.controller.raiseNotification({ memberId: 'petr', kind: 'agent-waiting', title: 'A' });
        core.controller.raiseNotification({ memberId: 'petr', kind: 'agent-waiting', title: 'B' });
        core.controller.raiseNotification({ memberId: 'jana', kind: 'agent-waiting', title: 'No dashboard ID' });
        core.controller.raiseNotification({ memberId: 'eva', kind: 'task-failed', title: 'Disabled' });
        core.controller.raiseNotification({ memberId: 'member-owner', kind: 'task-failed', title: 'The owner' });
        core.controller.raiseNotification({ memberId: null, kind: 'tool-sign-in', title: 'Project' });
        expect(core.controller.attention()).toEqual([
            { to: 'dash-petr', kind: 'agent-waiting', count: 2 },
            { kind: 'tool-sign-in', count: 1 },
        ]);
        ok(await petr.notifications.markSeen({ ids: [waiting.id] }, signal()));
        expect(core.controller.attention()).toContainEqual({ to: 'dash-petr', kind: 'agent-waiting', count: 1 });
        expect(JSON.stringify(core.controller.attention())).not.toMatch(/Project|notification-/);
    });

    it('keeps the largest counts when more than the heartbeat carries wait', () => {
        const members = Array.from({ length: 30 }, (_, index) => member(`m${String(index)}`, `dash-${String(index)}`));
        const { core } = setup({ seed: { members } });
        for (const [index, { id }] of members.entries()) {
            for (const kind of ['agent-waiting', 'task-failed', 'tool-sign-in'] as const) {
                for (let copy = 0; copy <= index % 3; copy++) {
                    core.controller.raiseNotification({ memberId: id, kind, title: 'x' });
                }
            }
        }
        const attention = core.controller.attention() ?? [];
        expect(attention).toHaveLength(MAX_ATTENTION_ENTRIES);
        expect(attention.filter(({ count }) => count === 3)).toHaveLength(30);
        expect(attention.filter(({ count }) => count === 1)).toHaveLength(4);
    });

    it('lets the owner switch attention off and on, behind step-up and settings.manage, and audits it', async () => {
        const { core, owner, petr, clientAs } = setup();
        core.controller.raiseNotification({ memberId: 'petr', kind: 'agent-waiting', title: 'A' });
        expect(ok(await owner.settings.get(signal())).dashboardAttention).toBe(true);
        expect(codeOf(await petr.settings.setDashboardAttention({ enabled: false }, signal()))).toBe('forbidden');
        const stale = clientAs('member-owner', OWNER_PERMISSIONS, false);
        expect(codeOf(await stale.settings.setDashboardAttention({ enabled: false }, signal()))).toBe(
            'step-up-required',
        );
        expect(ok(await owner.settings.setDashboardAttention({ enabled: false }, signal()))).toEqual({
            enabled: false,
        });
        expect(ok(await owner.settings.get(signal())).dashboardAttention).toBe(false);
        expect(core.controller.attention()).toBeNull();
        ok(await owner.settings.setDashboardAttention({ enabled: true }, signal()));
        expect(core.controller.attention()).toHaveLength(1);
        const audited = ok(await owner.audit.list({}, signal())).items.filter(
            ({ action }) => action === 'settings.dashboard-attention',
        );
        expect(audited.map(({ outcome }) => outcome).sort()).toEqual(['denied', 'denied', 'success', 'success']);
    });

    it('starts off when the seed says so (strict mode), and has no switch or routes without the capability', async () => {
        const off = setup({
            seed: {
                settings: {
                    name: 'Strict',
                    defaultAgentVisibility: 'private',
                    updatePolicy: { policy: 'auto', pinnedVersion: null },
                    dashboardAttention: false,
                },
            },
        });
        expect(off.core.controller.attention()).toBeNull();

        const without = setup({
            capabilities: DEFAULT_CAPABILITIES.filter((ref) => ref !== KNOWN_CAPABILITIES.notifications),
        });
        expect(ok(await without.owner.settings.get(signal())).dashboardAttention).toBeNull();
        expect(without.core.controller.attention()).toBeNull();
        expect(codeOf(await without.owner.notifications.counts(signal()))).toBe('capability-not-supported');
        expect(defaultDashboardAttention(false, true)).toBeNull();
    });
});

describe('notifications@1 contract', () => {
    it('caps a mark-seen batch and refuses unknown fields', () => {
        const ids = Array.from({ length: MAX_NOTIFICATIONS_PER_SEEN + 1 }, (_, index) => `n${String(index)}`);
        expect(MarkNotificationsSeenBody.safeParse({ ids: ids.slice(1) }).success).toBe(true);
        expect(MarkNotificationsSeenBody.safeParse({ ids }).success).toBe(false);
        expect(MarkNotificationsSeenBody.safeParse({ ids: [] }).success).toBe(false);
        expect(MarkNotificationsSeenBody.safeParse({ ids: ['a'], all: true }).success).toBe(false);
    });

    it('reads a newer engine’s kinds and targets tolerantly, keeping the text', () => {
        const base = {
            id: 'n1',
            kind: 'agent-waiting',
            audience: 'personal',
            title: 'Hello',
            detail: null,
            target: { kind: 'run', runId: 'r1', extra: true },
            createdAt: '2026-11-27T08:00:00Z',
            seenAt: null,
            priority: 'high',
        };
        expect(NotificationReader.parse(base)).toMatchObject({ target: { kind: 'run', runId: 'r1' } });
        expect(NotificationReader.parse(base)).not.toHaveProperty('priority');
        const newer = NotificationReader.parse({
            ...base,
            kind: 'budget-reached',
            audience: 'team',
            target: { kind: 'invoice', invoiceId: 'i1' },
        });
        expect(newer).toMatchObject({ kind: 'unknown', audience: 'unknown', target: null, title: 'Hello' });
        expect(NotificationPageReader.parse({ items: [base], nextCursor: null }).items).toHaveLength(1);
    });
});
