import { OWNER_PERMISSIONS } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { renderWithProviders } from '../../testing/render-with-providers';
import { createSecurityEngine } from '../../testing/security-engine';
import { problemResponse } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
/** As many members as M-04's `large-fleet` scenario. */
const MEMBER_COUNT = 40;
const PAGE_SIZE = 15;

function members(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        id: `member-${String(index + 1).padStart(3, '0')}`,
        displayName: `Member ${String(index + 1).padStart(3, '0')}`,
        role: index % 4 === 0 ? ('admin' as const) : ('member' as const),
        status: 'active' as const,
        createdAt: '2026-09-01T00:00:00Z',
        lastSeenAt: index % 2 === 0 ? '2026-10-01T10:00:00Z' : null,
    }));
}

/** The engine pages 50 by default; a smaller page makes the large fleet span several, as it would with more members. */
function largeFleet() {
    const engine = createSecurityEngine({ seed: { members: members(MEMBER_COUNT) } });
    const list: typeof engine.client.members.list = (query, signal) => engine.client.members.list(query, signal);
    return {
        ...engine,
        client: {
            ...engine.client,
            members: {
                ...engine.client.members,
                list: (query: Parameters<typeof list>[0], signal: AbortSignal) =>
                    list({ limit: PAGE_SIZE, ...query }, signal),
            },
        },
    };
}

const rowNames = () =>
    screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '');

describe('members', { timeout: TIMEOUT_MS }, () => {
    it('lists members read-only without members.manage, with role, passkeys, last seen and joined, and passes axe', async () => {
        const permissions = OWNER_PERMISSIONS.filter((permission) => permission !== 'members.manage');
        const engine = createSecurityEngine({ permissions, seed: { members: members(3) } });
        const { container } = renderWithProviders({ path: '/members', engineApi: engine.client });
        await screen.findByText('Member 001');
        for (const header of ['Name', 'Role', 'Passkeys', 'Last seen', 'Joined']) {
            expect(screen.getByRole('columnheader', { name: new RegExp(header) }), header).toBeDefined();
        }
        const owner = screen.getByText('You').closest('tr') as HTMLElement;
        expect(owner.textContent).toContain('Member');
        expect(owner.textContent).toContain('1');
        expect(screen.getByText('Member 002').closest('tr')?.textContent).toContain('Never');

        expect(screen.queryByRole('button', { name: /invite/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
        expect(screen.queryByRole('checkbox', { name: /Select/ })).toBeNull();
        expect(screen.queryByRole('combobox', { name: /role/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /remove|edit/i })).toBeNull();
        expect(
            screen.getByText('Owners and admins invite people from the dashboard and change their roles.'),
        ).toBeDefined();
        await expectNoAxeViolations(container);
    });

    it('pages through a large fleet with the cursor in the URL, and restores it on reload', async () => {
        const engine = largeFleet();
        const { user, router, unmount } = renderWithProviders({ path: '/members', engineApi: engine.client });
        await screen.findByText('Member 001');
        const seen = new Set(rowNames());
        const cursors: (string | undefined)[] = [];
        while (!screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')) {
            const before = rowNames()[0];
            await user.click(screen.getByRole('button', { name: 'Next page' }));
            await waitFor(() => {
                expect(rowNames()[0]).not.toBe(before);
            });
            cursors.push((router.state.location.search as { cursor?: string }).cursor);
            for (const name of rowNames()) seen.add(name);
        }
        // Every member exactly once, the signed-in owner included.
        expect(seen.size).toBe(MEMBER_COUNT + 1);
        expect(cursors.length).toBeGreaterThanOrEqual(2);
        const secondPage = cursors[0];
        expect(secondPage).toBeDefined();

        await user.click(screen.getByRole('button', { name: 'Previous page' }));
        await waitFor(() => {
            expect((router.state.location.search as { cursor?: string }).cursor).toBe(cursors.at(-2));
        });
        unmount();

        const reloaded = renderWithProviders({ path: `/members?cursor=${secondPage ?? ''}`, engineApi: engine.client });
        await waitFor(() => {
            expect(rowNames().length).toBe(PAGE_SIZE);
        });
        expect(screen.queryByText('Member 001')).toBeNull();
        expect((reloaded.router.state.location.search as { cursor?: string }).cursor).toBe(secondPage);
    });

    it('shows an error with retry when the list fails', async () => {
        const engine = createSecurityEngine({ seed: { members: members(3) } });
        const list = vi
            .spyOn(engine.client.members, 'list')
            .mockImplementation(() => problemResponse('validation-failed'));
        const { user } = renderWithProviders({ path: '/members', engineApi: engine.client });
        expect(await screen.findByText('The members could not be loaded.')).toBeDefined();
        list.mockRestore();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Member 001')).toBeDefined();
    });

    it('starts again from the first page on an expired cursor', async () => {
        const engine = createSecurityEngine({ seed: { members: members(3) } });
        vi.spyOn(engine.client.members, 'list').mockImplementationOnce(() => problemResponse('invalid-cursor'));
        const { router } = renderWithProviders({ path: '/members?cursor=expired', engineApi: engine.client });
        expect(await screen.findByText('Member 001')).toBeDefined();
        expect((router.state.location.search as { cursor?: string }).cursor).toBeUndefined();
    });
});

describe('access without permissions', { timeout: TIMEOUT_MS }, () => {
    it.each(['/members', '/wallet'])('%s says "no access"', async (path) => {
        renderWithProviders({ path, permissions: [] });
        expect(await screen.findByRole('heading', { name: 'No access' })).toBeDefined();
    });
});
