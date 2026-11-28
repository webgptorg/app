import { describe, expect, it } from 'vitest';

import { ATTENTION_KINDS } from '@ptbk/protocol';

import { m } from '../../paraglide/messages';
import { RECIPIENT_ROLES, type NotificationItem } from './notification-kind';
import {
    anyKind,
    effectiveChannel,
    isEngineKind,
    NOTIFICATION_KIND_IDS,
    NOTIFICATION_KINDS,
    notificationKindSchema,
    parseVariant,
    platformKind,
} from './registry';

const ROW = { count: 1, variant: null, openedAt: 100, updatedAt: 100, seenAt: null, emailedAt: null };

describe('the notification kind registry', () => {
    it('holds ADR 0027’s defaults per role, team admins included', () => {
        const table = Object.fromEntries(
            NOTIFICATION_KIND_IDS.map((kind) => [
                kind,
                RECIPIENT_ROLES.map((role) => effectiveChannel(kind, role, null)),
            ]),
        );
        expect(table).toEqual({
            'project-status': ['email', 'email', 'email', 'in-app'],
            'update-waiting': ['in-app', 'in-app', 'in-app', 'off'],
            'join-request': ['email', 'email', 'email', 'off'],
            'people-change': ['in-app', 'in-app', 'in-app', 'email'],
            'plan-limit': ['email', 'in-app', 'in-app', 'off'],
            'agent-waiting': ['email', 'email', 'email', 'email'],
            'task-failed': ['email', 'email', 'email', 'email'],
            'tool-sign-in': ['email', 'email', 'email', 'off'],
        });
        expect(effectiveChannel('agent-waiting', 'member', 'off')).toBe('off');
    });

    it('keeps engine kinds to the heartbeat’s closed `attention` enum and the people it may name', () => {
        expect(NOTIFICATION_KIND_IDS.filter(isEngineKind)).toEqual([...ATTENTION_KINDS]);
        for (const kind of NOTIFICATION_KIND_IDS) {
            expect(anyKind(kind).reach === 'managers-or-approved').toBe(isEngineKind(kind));
        }
    });

    it('parses kinds and variants closed, so a stray value from storage reads as nothing', () => {
        expect(notificationKindSchema.safeParse('agent-waiting').success).toBe(true);
        expect(notificationKindSchema.safeParse('agent-waiting ').success).toBe(false);
        expect(parseVariant('project-status', 'offline')).toBe('offline');
        expect(parseVariant('project-status', 'exploded')).toBeNull();
        expect(parseVariant('join-request', 'offline')).toBeNull();
        expect(parseVariant('project-status', null)).toBeNull();
    });

    it('has a label and a line in both locales for every kind and variant, naming only the place', () => {
        const place = { orgName: 'Acme', project: { label: 'Marketing site', hostname: 'm.engines.ptbk.test' } };
        for (const kind of NOTIFICATION_KIND_IDS) {
            const { copy, variants } = anyKind(kind);
            for (const locale of ['en', 'cs'] as const) {
                const context = { locale, time: () => '10:42', duration: () => '2 hours' };
                expect(copy.label()).not.toBe('');
                for (const variant of [null, ...variants]) {
                    const item: NotificationItem = { count: 2, variant, openedAt: 0, updatedAt: 0 };
                    const line = copy.line(item, place, context);
                    expect(line).not.toMatch(/undefined|null|\{/);
                    expect(line).toMatch(/Marketing site|Acme/);
                    expect(copy.subject(item, place, context)).not.toBe('');
                    expect(copy.link(item).to).toMatch(/^(project-page|project|dashboard)$/);
                    // A place with nothing named still reads as a sentence, and a detail without people too.
                    expect(copy.line(item, { orgName: null, project: null }, context)).not.toMatch(/undefined|null|\{/);
                    expect(copy.detail?.(item, place, context, { requesters: [] }) ?? '').not.toMatch(/undefined|\{/);
                }
            }
        }
        expect(m.notification_org_unnamed({}, { locale: 'en' })).toBe('your organization');
    });

    describe('project-status', () => {
        const kind = platformKind('project-status');

        it('opens on online once, offline always, and turns an emailed outage into back online', () => {
            expect(kind.reduce(null, { kind: 'online', at: 5 }, 9)).toEqual({
                op: 'put',
                count: 1,
                variant: 'online',
                openedAt: 5,
                rearm: true,
            });
            expect(kind.reduce({ ...ROW, variant: 'online' }, { kind: 'online', at: 5 }, 9)).toEqual({ op: 'keep' });
            expect(kind.reduce({ ...ROW, variant: 'online' }, { kind: 'offline', lastSeenAt: 3 }, 9)).toMatchObject({
                variant: 'offline',
                openedAt: 3,
            });
            const outage = { ...ROW, variant: 'offline' as const, openedAt: 3 };
            expect(kind.reduce(outage, { kind: 'back-online' }, 9)).toEqual({ op: 'close' });
            expect(kind.reduce({ ...outage, emailedAt: 4 }, { kind: 'back-online' }, 9)).toEqual({
                op: 'put',
                count: 1,
                variant: 'back-online',
                openedAt: 3,
                rearm: true,
            });
            expect(kind.reduce(null, { kind: 'back-online' }, 9)).toEqual({ op: 'keep' });
            expect(kind.timing.closesWhenSeen('offline')).toBe(false);
            expect(kind.timing.closesWhenSeen('back-online')).toBe(true);
        });
    });

    it('closes a join request once every waiting one is answered', () => {
        const kind = platformKind('join-request');
        expect(kind.reduce(null, { kind: 'answered', requests: 1 }, 9)).toEqual({ op: 'keep' });
        expect(kind.reduce({ ...ROW, count: 2 }, { kind: 'answered', requests: 1 }, 9)).toMatchObject({
            count: 1,
            rearm: false,
        });
        expect(kind.reduce({ ...ROW, count: 1 }, { kind: 'answered', requests: 3 }, 9)).toEqual({ op: 'close' });
    });

    it('lists the registry in the order the settings show it', () => {
        expect(Object.keys(NOTIFICATION_KINDS)).toEqual(NOTIFICATION_KIND_IDS);
    });
});
