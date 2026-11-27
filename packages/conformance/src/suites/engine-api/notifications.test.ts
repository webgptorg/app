import { KNOWN_CAPABILITIES, NOTIFICATION_KINDS } from '@ptbk/engine-api';
import { ATTENTION_KINDS } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { CheckOutcome } from '../../check';
import { runConformance } from '../../runner';
import type { ConformanceTarget } from '../../target';
import type { FakeEngineOptions, Tamper } from '../../testing/fake-engine';
import { createFakeEngine } from '../../testing/fake-engine';
import { ENGINE_API_SUITE } from './index';

const CHECKS = {
    ownItems: 'engine-api.notifications.own-items',
    seenLowers: 'engine-api.notifications.seen-lowers-count',
    projectWide: 'engine-api.notifications.project-wide',
    strictInput: 'engine-api.notifications.strict-input',
    switch: 'engine-api.notifications.switch',
} as const;

async function outcome(
    id: string,
    options: FakeEngineOptions = {},
    target: (fake: ConformanceTarget) => ConformanceTarget = (fake) => fake,
): Promise<CheckOutcome> {
    const fake = await createFakeEngine(options);
    const report = await runConformance({
        target: target(fake.target),
        suites: [ENGINE_API_SUITE],
        filter: (check) => check.id === id,
        timeoutMs: 30_000,
        signal: AbortSignal.timeout(60_000),
        seed: 21,
    });
    const result = report.results.find((candidate) => candidate.id === id);
    if (!result) throw new Error(`no result for ${id}`);
    return result.outcome;
}

const path = (request: Request): string => new URL(request.url).pathname.slice('/api/v1'.length);
const is = (request: Request, method: string, route: string) => request.method === method && path(request) === route;
const NO_COUNTS = { total: 0, byKind: { 'agent-waiting': 0, 'task-failed': 0, 'tool-sign-in': 0 } };

/** Answers every refused request to `route` with `body`, as an engine that skips the check would. */
const accepts =
    (method: string, route: string, body: unknown): Tamper =>
    (request, response) =>
        is(request, method, route) && response.status >= 400 ? Response.json(body) : response;

const NO_NOTIFICATIONS = Object.values(KNOWN_CAPABILITIES).filter((ref) => ref !== KNOWN_CAPABILITIES.notifications);

describe('the notifications checks', () => {
    it('use the same kinds as the heartbeat', () => {
        expect(NOTIFICATION_KINDS).toEqual(ATTENTION_KINDS);
    });

    it.each(Object.values(CHECKS))('pass against the in-memory engine: %s', async (id) => {
        expect(await outcome(id)).toEqual({ kind: 'pass' });
    });

    it.each(Object.values(CHECKS))('skip without the capability: %s', async (id) => {
        expect(await outcome(id, { capabilities: NO_NOTIFICATIONS })).toEqual({
            kind: 'skip',
            reason: 'capability-not-advertised',
        });
    });

    it.each([CHECKS.ownItems, CHECKS.seenLowers, CHECKS.projectWide])(
        'skip when the target cannot raise notifications: %s',
        async (id) => {
            const withoutLever = (target: ConformanceTarget): ConformanceTarget => {
                const rest: Partial<ConformanceTarget> = { ...target };
                delete rest.notifications;
                return rest as ConformanceTarget;
            };
            expect(await outcome(id, {}, withoutLever)).toMatchObject({ kind: 'skip' });
        },
    );

    it('fail when another member can mark someone’s item seen', async () => {
        const tamper = accepts('POST', '/me/notifications/seen', NO_COUNTS);
        expect(await outcome(CHECKS.ownItems, { tamper })).toMatchObject({ kind: 'fail' });
    });

    it('fail when one member’s list carries another’s items', async () => {
        let leaked: unknown[] = [];
        const tamper: Tamper = async (request, response) => {
            if (!is(request, 'GET', '/me/notifications') || response.status !== 200) return response;
            const page = (await response.json()) as { items: unknown[]; nextCursor: null };
            leaked = [...leaked, ...page.items];
            return Response.json({ ...page, items: [...new Set([...page.items, ...leaked])] });
        };
        expect(await outcome(CHECKS.ownItems, { tamper })).toMatchObject({ kind: 'fail' });
    });

    it('fail when seeing an item does not lower the count', async () => {
        let first: unknown = null;
        const tamper: Tamper = async (request, response) => {
            if (!is(request, 'GET', '/me/notifications/unseen')) return response;
            first ??= await response.json();
            return Response.json(first);
        };
        expect(await outcome(CHECKS.seenLowers, { tamper })).toMatchObject({ kind: 'fail' });
    });

    it('fail when a seen item leaves the inbox or keeps seenAt null', async () => {
        const drop: Tamper = async (request, response) => {
            if (!is(request, 'GET', '/me/notifications')) return response;
            const page = (await response.json()) as { items: { seenAt: string | null }[]; nextCursor: null };
            return Response.json({ ...page, items: page.items.filter(({ seenAt }) => seenAt === null) });
        };
        const unseen: Tamper = async (request, response) => {
            if (!is(request, 'GET', '/me/notifications')) return response;
            const page = (await response.json()) as { items: { seenAt: string | null }[]; nextCursor: null };
            return Response.json({ ...page, items: page.items.map((item) => ({ ...item, seenAt: null })) });
        };
        expect(await outcome(CHECKS.seenLowers, { tamper: drop })).toMatchObject({ kind: 'fail' });
        expect(await outcome(CHECKS.seenLowers, { tamper: unseen })).toMatchObject({ kind: 'fail' });
    });

    it('fail when a non-manager sees project-wide items', async () => {
        const tamper: Tamper = async (request, response) => {
            if (!is(request, 'GET', '/me/notifications')) return response;
            const page = (await response.json()) as { items: unknown[]; nextCursor: null };
            const item = {
                id: 'leaked-project-item',
                kind: 'tool-sign-in',
                audience: 'project',
                title: 'Leaked',
                detail: null,
                target: null,
                createdAt: '2026-11-27T08:00:00Z',
                seenAt: null,
            };
            return Response.json({ ...page, items: [...page.items, item] });
        };
        expect(await outcome(CHECKS.projectWide, { tamper })).toMatchObject({ kind: 'fail' });
    });

    it('fail when the inbox answers anonymous callers or loose bodies', async () => {
        const anonymous: Tamper = (request, response) =>
            is(request, 'GET', '/me/notifications/unseen') && response.status === 401
                ? Response.json(NO_COUNTS)
                : response;
        expect(await outcome(CHECKS.strictInput, { tamper: anonymous })).toMatchObject({ kind: 'fail' });
        const loose = accepts('POST', '/me/notifications/seen', NO_COUNTS);
        expect(await outcome(CHECKS.strictInput, { tamper: loose })).toMatchObject({ kind: 'fail' });
    });

    it('fail when anyone may flip the switch, or the switch does not stick or is missing', async () => {
        const anyone = accepts('PUT', '/settings/dashboard-attention', { enabled: true });
        expect(await outcome(CHECKS.switch, { tamper: anyone })).toMatchObject({ kind: 'fail' });
        const settingsWith =
            (dashboardAttention: unknown): Tamper =>
            async (request, response) => {
                if (!is(request, 'GET', '/settings')) return response;
                return Response.json({ ...((await response.json()) as object), dashboardAttention });
            };
        expect(await outcome(CHECKS.switch, { tamper: settingsWith(true) })).toMatchObject({ kind: 'fail' });
        expect(await outcome(CHECKS.switch, { tamper: settingsWith(null) })).toMatchObject({ kind: 'fail' });
    });
});
