import { AUDIT_ACTIONS } from '@ptbk/engine-api';
import type { AuditListQuery, Permission } from '@ptbk/engine-api';
import type { InMemorySeedAuditEntry } from '@ptbk/engine-api/in-memory';
import { focusManager } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import type { RenderedApp } from '../../testing/render-with-providers';
import { createSecurityEngine } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 30_000;
const HOSTILE = '<img src=x onerror=alert(1)>';
const START_MS = Date.parse('2026-09-01T00:00:00Z');
const HOUR_MS = 3_600_000;
const SEEDED_ACTIONS = ['agent.create', 'secret.replace', 'folder.rename', 'agent.stop'] as const;
const KINDS = {
    'agent.create': 'agent',
    'secret.replace': 'secret',
    'folder.rename': 'folder',
    'agent.stop': 'agent',
} as const;
const OUTCOMES = ['success', 'success', 'denied', 'failed'] as const;

/** Entry `n` (1-based) happens `n` hours after the start; the newest is shown first. */
function entry(n: number): InMemorySeedAuditEntry {
    const action = SEEDED_ACTIONS[n % SEEDED_ACTIONS.length] ?? 'agent.create';
    return {
        at: new Date(START_MS + n * HOUR_MS).toISOString().replace('.000Z', 'Z'),
        actor:
            n % 10 === 0
                ? { kind: 'system' }
                : { kind: 'member', memberId: n % 2 === 0 ? 'member-jana' : 'member-petr' },
        action,
        target: { kind: KINDS[action], id: `target-${String(n)}`, name: n === 7 ? HOSTILE : `Target ${String(n)}` },
        outcome: OUTCOMES[n % OUTCOMES.length] ?? 'success',
        client: n % 10 === 0 ? null : { ip: '203.0.113.7', userAgent: `Firefox/${String(n)}` },
        details: { fields: ['name'], n },
    };
}

const ENTRIES = Array.from({ length: 230 }, (_, index) => entry(index + 1));

function auditEngine(options: { count?: number; permissions?: readonly Permission[] } = {}) {
    const engine = createSecurityEngine({
        ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
        seed: {
            members: [
                {
                    id: 'member-jana',
                    displayName: 'Jana Nováková',
                    role: 'admin',
                    status: 'active',
                    createdAt: '2026-08-01T00:00:00Z',
                    lastSeenAt: null,
                },
                {
                    id: 'member-petr',
                    displayName: 'Petr Svoboda',
                    role: 'member',
                    status: 'active',
                    createdAt: '2026-08-01T00:00:00Z',
                    lastSeenAt: null,
                },
            ],
            auditEntries: ENTRIES.slice(0, options.count ?? ENTRIES.length),
        },
    });
    const audit = { ...engine.client.audit };
    const spies = { list: vi.spyOn(audit, 'list'), verify: vi.spyOn(audit, 'verify') };
    return { client: { ...engine.client, audit }, spies };
}

type ListQuery = z.input<typeof AuditListQuery>;
const lastQuery = (spy: ReturnType<typeof auditEngine>['spies']['list']): ListQuery | undefined =>
    spy.mock.calls.at(-1)?.[0];

/** Target names in the order the rows show them. */
function shownTargets(): string[] {
    return screen.getAllByText(/^Target \d+$/).map((element) => element.textContent);
}

const expectedTargets = (from: number, to: number) =>
    Array.from({ length: from - to + 1 }, (_, index) => from - index)
        .filter((n) => n !== 7)
        .map((n) => `Target ${String(n)}`);

async function nextPage(app: RenderedApp, firstTarget: string) {
    await app.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(firstTarget);
}

describe('audit log: paging', { timeout: TIMEOUT_MS }, () => {
    it('pages through all 230 entries newest first, 50 at a time', async () => {
        const engine = auditEngine();
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        expect(await screen.findByText('Target 230')).toBeDefined();
        expect(shownTargets()).toEqual(expectedTargets(230, 181));
        expect(lastQuery(engine.spies.list)).toEqual({ limit: 50 });
        await nextPage(app, 'Target 180');
        expect(shownTargets()).toEqual(expectedTargets(180, 131));
        await nextPage(app, 'Target 130');
        await nextPage(app, 'Target 80');
        await nextPage(app, 'Target 30');
        expect(shownTargets()).toEqual(expectedTargets(30, 1));
        expect(screen.getByText(HOSTILE)).toBeDefined();
        expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
        await app.user.click(screen.getByRole('button', { name: 'Previous page' }));
        expect(await screen.findByText('Target 80')).toBeDefined();
    });

    it('prefetches the next page when "Next" gets focus, so the click shows it without a skeleton', async () => {
        const engine = auditEngine();
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 230');
        const calls = engine.spies.list.mock.calls.length;
        const next = screen.getByRole('button', { name: 'Next page' });
        next.focus();
        await waitFor(() => {
            expect(engine.spies.list).toHaveBeenCalledTimes(calls + 1);
        });
        expect(lastQuery(engine.spies.list)?.cursor).toBeDefined();
        await waitFor(() => {
            expect(app.queryClient.isFetching()).toBe(0);
        });
        await app.user.click(next);
        expect(screen.getByText('Target 180')).toBeDefined();
        expect(document.querySelector('[aria-busy="true"]')).toBeNull();
        expect(engine.spies.list).toHaveBeenCalledTimes(calls + 1);
    });

    it('starts again from the first page on an expired cursor', async () => {
        const engine = auditEngine({ count: 3 });
        engine.spies.list.mockImplementationOnce(() => problemResponse('invalid-cursor'));
        const { router } = renderWithProviders({ path: '/audit?cursor=expired', engineApi: engine.client });
        expect(await screen.findByText('Target 3')).toBeDefined();
        expect((router.state.location.search as { cursor?: string }).cursor).toBeUndefined();
    });
});

describe('audit log: filters', { timeout: TIMEOUT_MS }, () => {
    it('narrows by every filter, writes them to the URL and restores them on reload', async () => {
        const engine = auditEngine();
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 230');
        await app.user.click(screen.getByRole('button', { name: 'Next page' }));
        await screen.findByText('Target 180');

        await app.user.selectOptions(screen.getByRole('combobox', { name: 'Member' }), 'member-petr');
        await waitFor(() => {
            expect(lastQuery(engine.spies.list)).toEqual({ limit: 50, memberId: 'member-petr' });
        });
        expect(await screen.findByText('Target 229')).toBeDefined();
        expect(screen.queryByText('Target 228')).toBeNull();

        await app.user.selectOptions(screen.getByRole('combobox', { name: 'Action' }), 'secret.replace');
        await app.user.selectOptions(screen.getByRole('combobox', { name: 'Target type' }), 'secret');
        await app.user.selectOptions(screen.getByRole('combobox', { name: 'Outcome' }), 'success');
        await app.user.type(screen.getByRole('textbox', { name: 'Target ID' }), 'target-225');
        await waitFor(() => {
            expect(lastQuery(engine.spies.list)).toEqual({
                limit: 50,
                memberId: 'member-petr',
                action: 'secret.replace',
                targetKind: 'secret',
                targetId: 'target-225',
                outcome: 'success',
            });
        });
        expect(await screen.findByText('Target 225')).toBeDefined();
        expect(shownTargets()).toEqual(['Target 225']);

        const from = screen.getByLabelText('From');
        await app.user.type(from, '2026-09-10');
        await app.user.type(screen.getByLabelText('To'), '2026-09-10');
        const search = app.router.state.location.search;
        expect(search).toMatchObject({
            memberId: 'member-petr',
            action: 'secret.replace',
            targetKind: 'secret',
            targetId: 'target-225',
            outcome: 'success',
            from: '2026-09-10',
            to: '2026-09-10',
        });
        expect(search).not.toHaveProperty('cursor');
        await waitFor(() => {
            expect(lastQuery(engine.spies.list)).toMatchObject({
                from: new Date(2026, 8, 10).toISOString(),
                to: new Date(2026, 8, 11).toISOString(),
            });
        });
        expect(await screen.findByText('Target 225')).toBeDefined();

        const reloaded = auditEngine();
        app.unmount();
        renderWithProviders({ path: app.router.state.location.href, engineApi: reloaded.client });
        expect(await screen.findByText('Target 225')).toBeDefined();
        expect(shownTargets()).toEqual(['Target 225']);
        expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Member' }).value).toBe('member-petr');
        expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target ID' }).value).toBe('target-225');
        expect(screen.getByLabelText<HTMLInputElement>('From').value).toBe('2026-09-10');
        expect(reloaded.spies.list).toHaveBeenCalledOnce();
        expect(lastQuery(reloaded.spies.list)).toMatchObject({ targetId: 'target-225', outcome: 'success' });
    });

    it('sends combined filters from the URL in one request', async () => {
        const engine = auditEngine();
        renderWithProviders({
            path: '/audit?memberId=member-petr&action=agent.create&targetKind=agent&outcome=denied&from=2026-09-01',
            engineApi: engine.client,
        });
        await screen.findByRole('heading', { name: 'Audit log' });
        await waitFor(() => {
            expect(engine.spies.list).toHaveBeenCalledOnce();
        });
        expect(lastQuery(engine.spies.list)).toEqual({
            limit: 50,
            memberId: 'member-petr',
            action: 'agent.create',
            targetKind: 'agent',
            outcome: 'denied',
            from: new Date(2026, 8, 1).toISOString(),
        });
    });

    it('falls back to no filter for invalid params instead of failing', async () => {
        const engine = auditEngine({ count: 3 });
        renderWithProviders({
            path: '/audit?outcome=bogus&from=2026-02-30&to=yesterday&action=agent.clone&targetId=%3Cimg%3E&cursor=%25',
            engineApi: engine.client,
        });
        expect(await screen.findByText('Target 3')).toBeDefined();
        expect(engine.spies.list.mock.calls.map(([query]) => query)).toEqual([{ limit: 50 }]);
    });

    it('does not send a malformed target ID and says why', async () => {
        const engine = auditEngine({ count: 3 });
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 3');
        await app.user.type(screen.getByRole('textbox', { name: 'Target ID' }), 'a b');
        expect(await screen.findByText('Use letters, digits, - and _ only, at most 64.')).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(app.router.state.location.search).not.toHaveProperty('targetId');
    });
});

describe('audit log: entries', { timeout: TIMEOUT_MS }, () => {
    it('expands a row by keyboard and by mouse, and copies the exact hash', async () => {
        const engine = auditEngine({ count: 3 });
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 3');
        const writeText = vi.fn(() => Promise.resolve());
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        const page = await engine.client.audit.list({ limit: 3 }, AbortSignal.timeout(1000));
        if (page.kind !== 'ok') throw new Error('expected entries');
        const [third, second] = page.data.items;
        if (third === undefined || second === undefined) throw new Error('expected entries');

        const [firstExpand] = screen.getAllByRole('button', { name: /^Expand Agent stopped/ });
        if (firstExpand === undefined) throw new Error('expected an expand button');
        firstExpand.focus();
        await app.user.keyboard('{Enter}');
        expect(firstExpand.getAttribute('aria-expanded')).toBe('true');
        expect(await screen.findByText('Entry hash')).toBeDefined();
        expect(screen.getByText(JSON.stringify(third.details, null, 2), { normalizer: (text) => text })).toBeDefined();
        await app.user.click(screen.getByRole('button', { name: 'Copy entry hash' }));
        expect(writeText).toHaveBeenLastCalledWith(third.hash);
        await app.user.click(screen.getByRole('button', { name: 'Copy previous entry hash' }));
        expect(writeText).toHaveBeenLastCalledWith(second.hash);
        expect(third.prevHash).toBe(second.hash);

        await app.user.click(firstExpand);
        expect(firstExpand.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByText('Entry hash')).toBeNull();
    });

    it('shows the first entry without a previous hash', async () => {
        const engine = auditEngine({ count: 1 });
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 1');
        await app.user.click(screen.getByRole('button', { name: /^Expand / }));
        expect(await screen.findByText('None: this is the first entry.')).toBeDefined();
    });

    it('renders a hostile target name, user agent and details as literal text', async () => {
        const engine = auditEngine({ count: 7 });
        engine.spies.list.mockImplementation(async (query, signal) => {
            const page = await createSecurityEngine({
                seed: {
                    auditEntries: [
                        {
                            ...entry(7),
                            client: { ip: '203.0.113.9', userAgent: '<script>alert(1)</script>' },
                            details: { note: HOSTILE },
                        },
                    ],
                },
            }).client.audit.list(query, signal);
            return page;
        });
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        expect(await screen.findByText(HOSTILE)).toBeDefined();
        expect(screen.getByText('<script>alert(1)</script>')).toBeDefined();
        await app.user.click(screen.getByRole('button', { name: /^Expand / }));
        expect(within(screen.getByTestId('audit-details')).getByText(/onerror=alert/)).toBeDefined();
        expect(screen.getByRole('table').querySelector('img, script')).toBeNull();
    });

    it("shows a newer engine's unknown action as its raw name and labels known ones", async () => {
        const engine = auditEngine({ count: 1 });
        engine.spies.list.mockImplementation(() =>
            Promise.resolve({
                kind: 'ok',
                data: {
                    items: [
                        {
                            id: 'audit-9',
                            seq: 9,
                            at: '2026-09-02T00:00:00Z',
                            actor: { kind: 'system' },
                            action: 'agent.clone',
                            target: null,
                            outcome: 'success',
                            client: null,
                            hash: 'a'.repeat(64),
                            prevHash: null,
                        },
                    ],
                    nextCursor: null,
                },
            } as never),
        );
        renderWithProviders({ path: '/audit', engineApi: engine.client });
        expect(await screen.findByText('agent.clone')).toBeDefined();
        expect(within(screen.getByRole('table')).getByText('System')).toBeDefined();
        const action = screen.getByRole('combobox', { name: 'Action' });
        expect(within(action).getAllByRole('option')).toHaveLength(AUDIT_ACTIONS.length + 1);
        expect(within(action).getByRole('option', { name: 'Secret value replaced' })).toBeDefined();
    });

    it('names actors from the members list and falls back to the ID', async () => {
        const engine = auditEngine({ count: 3 });
        renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 3');
        const table = screen.getByRole('table');
        expect(await within(table).findAllByText('Petr Svoboda')).toHaveLength(2);
        expect(within(table).getByText('Jana Nováková')).toBeDefined();

        const limited = auditEngine({ count: 3, permissions: ['audit.read'] });
        renderWithProviders({ path: '/audit', engineApi: limited.client });
        expect(await screen.findAllByText('member-petr')).not.toHaveLength(0);
    });
});

describe('audit log: chain status and refresh', { timeout: TIMEOUT_MS }, () => {
    it('reports an intact chain with the time checked', async () => {
        renderWithProviders({ path: '/audit', engineApi: auditEngine({ count: 3 }).client });
        expect(await screen.findByText('Hash chain intact')).toBeDefined();
        expect(screen.getByText(/3 entries, none removed or edited/)).toBeDefined();
    });

    it('shows a danger banner with the first broken sequence number', async () => {
        const engine = auditEngine({ count: 3 });
        engine.spies.verify.mockResolvedValue({
            kind: 'ok',
            data: {
                status: 'broken',
                checkedEntries: 3,
                lastSeq: 3,
                firstBrokenSeq: 2,
                checkedAt: '2026-10-01T12:00:00Z',
            },
        } as never);
        renderWithProviders({ path: '/audit', engineApi: engine.client });
        const banner = await screen.findByRole('alert');
        expect(within(banner).getByText('Hash chain broken')).toBeDefined();
        expect(within(banner).getByText(/entry 2 does not follow/)).toBeDefined();
    });

    it('says when the chain status cannot be loaded and retries it', async () => {
        const engine = auditEngine({ count: 3 });
        engine.spies.verify.mockImplementation(() => problemResponse('validation-failed'));
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        expect(await screen.findByText("The engine's chain check could not be loaded.")).toBeDefined();
        engine.spies.verify.mockRestore();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Hash chain intact')).toBeDefined();
    });

    it('refreshes only when asked', async () => {
        const engine = auditEngine({ count: 3 });
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 3');
        await screen.findByText('Hash chain intact');
        const lists = engine.spies.list.mock.calls.length;
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(engine.spies.list).toHaveBeenCalledTimes(lists);
        focusManager.setFocused(undefined);
        await app.user.click(screen.getByRole('button', { name: 'Refresh' }));
        await waitFor(() => {
            expect(engine.spies.list).toHaveBeenCalledTimes(lists + 1);
            expect(engine.spies.verify).toHaveBeenCalledTimes(2);
        });
    });
});

describe('audit log: states', { timeout: TIMEOUT_MS }, () => {
    it('says when there are no entries yet', async () => {
        const app = renderWithProviders({ path: '/audit', engineApi: auditEngine({ count: 0 }).client });
        expect(await screen.findByText('No entries yet')).toBeDefined();
        await screen.findByText('Hash chain intact');
        await expectNoAxeViolations(app.container);
    });

    it('says when nothing matches the filters and clears them', async () => {
        const engine = auditEngine({ count: 3 });
        const app = renderWithProviders({ path: '/audit?targetId=nothing', engineApi: engine.client });
        expect(await screen.findByText('No matching entries')).toBeDefined();
        await expectNoAxeViolations(app.container);
        const [, clearInEmptyState] = screen.getAllByRole('button', { name: 'Clear filters' });
        if (clearInEmptyState === undefined) throw new Error('expected a second clear button');
        await app.user.click(clearInEmptyState);
        expect(await screen.findByText('Target 3')).toBeDefined();
        expect(app.router.state.location.search).toEqual({});
        expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Target ID' }).value).toBe('');
    });

    it('shows an error with a retry', async () => {
        const engine = auditEngine({ count: 3 });
        engine.spies.list.mockImplementation(() => problemResponse('validation-failed'));
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        expect(await screen.findByText('The audit log could not be loaded.')).toBeDefined();
        await expectNoAxeViolations(app.container);
        engine.spies.list.mockRestore();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Target 3')).toBeDefined();
    });

    it('passes axe with rows and an expanded entry', async () => {
        const app = renderWithProviders({ path: '/audit', engineApi: auditEngine({ count: 5 }).client });
        await screen.findByText('Target 5');
        await screen.findByText('Hash chain intact');
        const [expand] = screen.getAllByRole('button', { name: /^Expand / });
        if (expand === undefined) throw new Error('expected an expand button');
        await app.user.click(expand);
        await expectNoAxeViolations(app.container);
    });

    it('hides the client IP and device below 1024 px until the reader shows them', async () => {
        const engine = auditEngine({ count: 3 });
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 3');
        expect(screen.getByRole('columnheader', { name: 'Client IP' })).toBeDefined();
        app.media.set('(max-width: 1023.98px)', true);
        await waitFor(() => {
            expect(screen.queryByRole('columnheader', { name: 'Client IP' })).toBeNull();
        });
        expect(screen.queryByRole('columnheader', { name: 'Device' })).toBeNull();
    });
});

describe('audit log: access', { timeout: TIMEOUT_MS }, () => {
    it('says "no access" without audit.read and hides the sidebar item', async () => {
        renderWithProviders({ path: '/audit', permissions: ['agents.read'] });
        expect(await screen.findByRole('heading', { name: 'No access' })).toBeDefined();
        const nav = screen.getByRole('navigation', { name: /main|sections|primary/i });
        expect(within(nav).queryByRole('link', { name: 'Audit log' })).toBeNull();
    });

    it('lists the sidebar item with audit.read', async () => {
        renderWithProviders({
            path: '/audit',
            engineApi: auditEngine({ count: 1, permissions: ['audit.read'] }).client,
        });
        await screen.findByText('Target 1');
        expect(screen.getAllByRole('link', { name: 'Audit log' }).length).toBeGreaterThan(0);
    });
});
