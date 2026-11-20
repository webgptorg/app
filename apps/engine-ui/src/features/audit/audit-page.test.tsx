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
const SEEDED_ACTIONS = ['agent.create', 'wallet.record.update', 'folder.rename', 'agent.stop'] as const;
const KINDS = {
    'agent.create': 'agent',
    'wallet.record.update': 'wallet-record',
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

const dialog = () => screen.getByRole('dialog');

/** "+ Filter", then the field, as the shared filter bar offers them. */
async function addFilter(app: RenderedApp, field: string) {
    await app.user.click(screen.getByRole('button', { name: /^Filter$/ }));
    await app.user.click(within(dialog()).getByRole('option', { name: field }));
}

describe('audit log: filters', { timeout: TIMEOUT_MS }, () => {
    it('narrows by every filter, writes them to the URL and restores them on reload', async () => {
        const engine = auditEngine();
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 230');
        await app.user.click(screen.getByRole('button', { name: 'Next page' }));
        await screen.findByText('Target 180');

        await addFilter(app, 'Member');
        await app.user.click(within(dialog()).getByRole('option', { name: 'Petr Svoboda' }));
        await waitFor(() => {
            expect(lastQuery(engine.spies.list)).toEqual({ limit: 50, memberId: 'member-petr' });
        });
        expect(await screen.findByText('Target 229')).toBeDefined();
        expect(screen.queryByText('Target 228')).toBeNull();

        await addFilter(app, 'Action');
        await app.user.click(within(dialog()).getByRole('option', { name: 'Wallet login updated' }));
        await addFilter(app, 'Target type');
        await app.user.click(within(dialog()).getByRole('option', { name: 'Wallet login' }));
        await app.user.keyboard('{Escape}');
        await addFilter(app, 'Outcome');
        await app.user.click(within(dialog()).getByRole('option', { name: 'Succeeded' }));
        await app.user.keyboard('{Escape}');
        await app.user.type(screen.getByRole('searchbox', { name: 'Target ID' }), 'target-225');
        await waitFor(() => {
            expect(lastQuery(engine.spies.list)).toEqual({
                limit: 50,
                memberId: 'member-petr',
                action: 'wallet.record.update',
                targetKind: 'wallet-record',
                targetId: 'target-225',
                outcome: 'success',
            });
        });
        expect(await screen.findByText('Target 225')).toBeDefined();
        expect(shownTargets()).toEqual(['Target 225']);

        await addFilter(app, 'Date');
        await app.user.type(within(dialog()).getByLabelText('From'), '2026-09-10');
        await app.user.type(within(dialog()).getByLabelText('To'), '2026-09-10');
        await app.user.click(within(dialog()).getByRole('button', { name: 'Done' }));
        const search = app.router.state.location.search;
        expect(search).toMatchObject({
            memberId: 'member-petr',
            action: 'wallet.record.update',
            targetKind: 'wallet-record',
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
        expect(await screen.findByRole('button', { name: 'Member: Petr Svoboda' })).toBeDefined();
        expect(screen.getByRole('button', { name: 'Action: Wallet login updated' })).toBeDefined();
        expect(screen.getByRole('button', { name: /^Date: Sep 10/ })).toBeDefined();
        expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Target ID' }).value).toBe('target-225');
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
            path: '/audit?outcome=bogus&from=2026-02-30&to=yesterday&action=agent.clone&targetId=line%0Abreak&cursor=%25',
            engineApi: engine.client,
        });
        expect(await screen.findByText('Target 3')).toBeDefined();
        expect(engine.spies.list.mock.calls.map(([query]) => query)).toEqual([{ limit: 50 }]);
    });

    it('does not send a malformed target ID and says why', async () => {
        const engine = auditEngine({ count: 3 });
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 3');
        await app.user.type(screen.getByRole('searchbox', { name: 'Target ID' }), 'a b');
        expect(await screen.findByText('Use letters, digits, - and _ only, at most 64.')).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(app.router.state.location.search).not.toHaveProperty('targetId');
    });

    it('keeps an actor beyond the first page of members selected by its ID', async () => {
        renderWithProviders({ path: '/audit?memberId=member-gone', engineApi: auditEngine({ count: 3 }).client });
        expect(await screen.findByRole('button', { name: 'Member: member-gone' })).toBeDefined();
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
        expect(screen.queryByTestId('audit-details')).toBeNull();
        await app.user.click(screen.getByRole('button', { name: 'Raw JSON' }));
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
        expect(screen.getAllByText(HOSTILE)).toHaveLength(2);
        await app.user.click(screen.getByRole('button', { name: 'Raw JSON' }));
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
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        expect(await screen.findByText('agent.clone')).toBeDefined();
        expect(within(screen.getByRole('table')).getByText('System')).toBeDefined();
        await addFilter(app, 'Action');
        expect(within(dialog()).getAllByRole('option')).toHaveLength(AUDIT_ACTIONS.length);
        expect(within(dialog()).getByRole('option', { name: 'Wallet login updated' })).toBeDefined();
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

describe('audit log: filter bar', { timeout: TIMEOUT_MS }, () => {
    it('shows each filter in force as a chip that removes only that filter', async () => {
        const engine = auditEngine({ count: 3 });
        const app = renderWithProviders({
            path: '/audit?memberId=member-petr&action=agent.create&from=2026-09-01',
            engineApi: engine.client,
        });
        await screen.findByRole('button', { name: 'Member: Petr Svoboda' });
        expect(screen.getByRole('button', { name: 'Action: Agent created' })).toBeDefined();
        expect(screen.getByRole('button', { name: /^Date: from / })).toBeDefined();

        await app.user.click(screen.getByRole('button', { name: 'Remove Action: Agent created' }));
        await waitFor(() => {
            expect(app.router.state.location.search).toEqual({ memberId: 'member-petr', from: '2026-09-01' });
        });
        expect(screen.queryByRole('button', { name: /^Action:/ })).toBeNull();
        await waitFor(() => {
            expect(lastQuery(engine.spies.list)).toEqual({
                limit: 50,
                memberId: 'member-petr',
                from: new Date(2026, 8, 1).toISOString(),
            });
        });

        const bar = screen.getByRole('search', { name: 'Filters' });
        await app.user.click(within(bar).getByRole('button', { name: 'Clear filters' }));
        await waitFor(() => {
            expect(app.router.state.location.search).toEqual({});
        });
        expect(screen.queryByRole('button', { name: /^Member:/ })).toBeNull();
    });

    it("says the days are counted in the reader's time zone", async () => {
        const app = renderWithProviders({ path: '/audit', engineApi: auditEngine({ count: 3 }).client });
        await screen.findByText('Target 3');
        await addFilter(app, 'Date');
        expect(within(dialog()).getByLabelText('From').getAttribute('aria-describedby')).toBe(
            within(dialog()).getByText(/^Days in your time zone/).id,
        );
    });

    it('keeps the filters when a filtered log is empty, so they can be changed', async () => {
        renderWithProviders({ path: '/audit?targetId=nothing', engineApi: auditEngine({ count: 3 }).client });
        expect(await screen.findByText('No matching entries')).toBeDefined();
        expect(screen.getByRole('search', { name: 'Filters' })).toBeDefined();
    });
});

describe('audit log: rows', { timeout: TIMEOUT_MS }, () => {
    it('badges only denied and failed entries, so the exceptions stand out', async () => {
        renderWithProviders({ path: '/audit', engineApi: auditEngine({ count: 4 }).client });
        await screen.findByText('Target 4');
        const table = screen.getByRole('table');
        expect(within(table).queryByText('Succeeded')).toBeNull();
        expect(within(table).getAllByText('Denied')).toHaveLength(1);
        expect(within(table).getAllByText('Failed')).toHaveLength(1);
        expect(within(table).queryByRole('columnheader', { name: 'Outcome' })).toBeNull();
    });

    it('shows a short time in the row and the full one on hover and in the details', async () => {
        const app = renderWithProviders({ path: '/audit', engineApi: auditEngine({ count: 1 }).client });
        await screen.findByText('Target 1');
        const time = screen.getByRole('table').querySelector('tbody time');
        expect(time?.getAttribute('dateTime')).toBe('2026-09-01T01:00:00Z');
        expect(time?.textContent).not.toMatch(/2026/);
        expect(time?.getAttribute('title')).toMatch(/2026/);
        await app.user.click(screen.getByRole('button', { name: /^Expand / }));
        const details = screen.getByText('Sequence number').closest('dl');
        expect(details?.querySelector('time')?.textContent).toBe(time?.getAttribute('title'));
    });

    it('names a target by kind and name and keeps its ID in the details', async () => {
        const app = renderWithProviders({ path: '/audit', engineApi: auditEngine({ count: 1 }).client });
        await screen.findByText('Target 1');
        expect(screen.queryByText('target-1')).toBeNull();
        await app.user.click(screen.getByRole('button', { name: /^Expand / }));
        expect(screen.getByText('target-1')).toBeDefined();
        expect(screen.getByRole('button', { name: 'Copy target ID' })).toBeDefined();
    });

    it('says "This engine" for engine-wide actions and "Not recorded" only where a target was expected', async () => {
        const engine = auditEngine({ count: 1 });
        const seeded = (action: string, seq: number) => ({
            id: `audit-${String(seq)}`,
            seq,
            at: '2026-09-02T00:00:00Z',
            actor: { kind: 'system' },
            action,
            target: null,
            outcome: 'success',
            client: null,
            hash: String(seq).repeat(64),
            prevHash: null,
        });
        engine.spies.list.mockResolvedValue({
            kind: 'ok',
            data: { items: [seeded('settings.update-policy', 2), seeded('agent.create', 1)], nextCursor: null },
        } as never);
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        const table = await screen.findByRole('table');
        // Cells re-render once the member names arrive, so look the rows up after that.
        await within(table).findByText('Update policy changed');
        await waitFor(() => {
            expect(app.queryClient.isFetching()).toBe(0);
        });
        const policy = within(table).getByText('Update policy changed').closest('tr');
        const agent = within(table).getByText('Agent created').closest('tr');
        if (policy === null || agent === null) throw new Error('expected both rows');
        const targetColumn = screen.getByRole<HTMLTableCellElement>('columnheader', { name: 'Target' }).cellIndex;
        expect(policy.cells[targetColumn]?.textContent).toBe('This engine');
        expect(agent.cells[targetColumn]?.textContent).toBe('Not recorded');
    });

    it('shows known details as facts and the exact JSON only on request', async () => {
        const engine = auditEngine({ count: 1 });
        engine.spies.list.mockResolvedValue({
            kind: 'ok',
            data: {
                items: [
                    {
                        id: 'audit-1',
                        seq: 1,
                        at: '2026-09-02T00:00:00Z',
                        actor: { kind: 'system' },
                        action: 'settings.update-policy',
                        target: null,
                        outcome: 'denied',
                        client: null,
                        details: {
                            fields: ['policy', 'version'],
                            problem: 'permission-denied',
                            requiredPermission: 'settings.manage',
                            nested: { deep: true },
                        },
                        hash: 'a'.repeat(64),
                        prevHash: null,
                    },
                ],
                nextCursor: null,
            },
        } as never);
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await app.user.click(await screen.findByRole('button', { name: /^Expand / }));
        const facts = screen.getByText('Sequence number').closest('dl');
        if (facts === null) throw new Error('expected the details list');
        const fact = (label: string) => within(facts).getByText(label).nextElementSibling?.textContent;
        expect(fact('Changed')).toBe('policy, version');
        expect(fact('Reason')).toBe('permission-denied');
        expect(fact('Missing permission')).toBe('settings.manage');
        expect(fact('Outcome')).toBe('Denied');
        expect(within(facts).queryByText('nested')).toBeNull();
        const raw = screen.getByRole('button', { name: 'Raw JSON' });
        expect(raw.getAttribute('aria-expanded')).toBe('false');
        await app.user.click(raw);
        expect(within(screen.getByTestId('audit-details')).getByText(/"deep": true/)).toBeDefined();
    });
});

describe('audit log: chain status and refresh', { timeout: TIMEOUT_MS }, () => {
    it('reports an intact chain as one quiet line with the details on request', async () => {
        const app = renderWithProviders({ path: '/audit', engineApi: auditEngine({ count: 3 }).client });
        const status = await screen.findByRole('button', { name: /^Chain verified / });
        expect(screen.queryByRole('alert')).toBeNull();
        expect(status.getAttribute('aria-expanded')).toBe('false');
        expect(status.getAttribute('title')).toMatch(/all 3 entries are intact, none removed or edited\.$/);
        await app.user.click(status);
        expect(status.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByText(/^The project checked the whole chain at .+: all 3 entries are intact/)).toBeDefined();
    });

    it('words a single checked entry in the singular', async () => {
        const app = renderWithProviders({ path: '/audit', engineApi: auditEngine({ count: 1 }).client });
        await app.user.click(await screen.findByRole('button', { name: /^Chain verified / }));
        expect(screen.getByText(/: its one entry is intact\.$/)).toBeDefined();
    });

    it('shows a date with the check time when the check was not today', async () => {
        const engine = auditEngine({ count: 3 });
        engine.spies.verify.mockResolvedValue({
            kind: 'ok',
            data: {
                status: 'intact',
                checkedEntries: 3,
                lastSeq: 3,
                firstBrokenSeq: null,
                checkedAt: '2026-01-02T12:00:00Z',
            },
        } as never);
        renderWithProviders({ path: '/audit', engineApi: engine.client });
        expect(await screen.findByRole('button', { name: /^Chain verified Jan 2, 2026, / })).toBeDefined();
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
        expect(await screen.findByText("The project's chain check could not be loaded.")).toBeDefined();
        engine.spies.verify.mockRestore();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('button', { name: /^Chain verified / })).toBeDefined();
    });

    it('refreshes only when asked', async () => {
        const engine = auditEngine({ count: 3 });
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        await screen.findByText('Target 3');
        await screen.findByRole('button', { name: /^Chain verified / });
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
    it('says when there are no entries yet, without filters or a chain line over nothing', async () => {
        const engine = auditEngine({ count: 0 });
        const app = renderWithProviders({ path: '/audit', engineApi: engine.client });
        expect(await screen.findByText('No entries yet')).toBeDefined();
        await waitFor(() => {
            expect(engine.spies.verify).toHaveBeenCalled();
        });
        await waitFor(() => {
            expect(app.queryClient.isFetching()).toBe(0);
        });
        expect(screen.queryByRole('search', { name: 'Filters' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Chain verified / })).toBeNull();
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
        expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Target ID' }).value).toBe('');
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
        await screen.findByRole('button', { name: /^Chain verified / });
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

    it('shows agent targets as plain chips and asks for no agent list without agents.read', async () => {
        const { client } = auditEngine({ count: 3, permissions: ['audit.read'] });
        const agentList = vi.spyOn(client.agents, 'list');
        const app = renderWithProviders({ path: '/audit', engineApi: client });
        await screen.findByText('Target 3');
        await waitFor(() => {
            expect(app.queryClient.isFetching()).toBe(0);
        });
        expect(within(screen.getByRole('table')).queryByRole('link', { name: 'Target 3' })).toBeNull();
        expect(agentList).not.toHaveBeenCalled();
    });
});
