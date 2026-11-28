import { MemberId, PERMISSIONS, SIGN_IN_PATH, SIGN_OUT_PATH } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FEATURES } from '../../../app/features';
import { defineFeature } from '../../../app/registry/feature';
import { expectNoAxeViolations } from '../../../testing/axe';
import { createFakeMatchMedia } from '../../../testing/fake-match-media';
import { createHomeEngine } from '../../../testing/home-engine';
import { renderWithProviders } from '../../../testing/render-with-providers';
import { createMemoryStorage } from '../../../testing/memory-storage';
import { RUN_IDS } from '../../../testing/runs-engine';
import { createSecurityEngine, OWNER_ID } from '../../../testing/security-engine';
import { NARROW_QUERY } from '../use-media-query';
import { isPaletteShortcut } from './palette-launcher';
import { matchesQuery } from './palette-match';
import { MAX_RECENT, readRecentPicks, recentStorageKey, rememberPick } from './palette-recent';

const TIMEOUT_MS = 20_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

const searchBox = () => screen.findByRole('combobox', { name: 'Search agents, runs, pages and commands' });
const options = () =>
    within(screen.getByRole('listbox'))
        .queryAllByRole('option')
        .map((option) => option.textContent);
const groupNames = () =>
    within(screen.getByRole('listbox'))
        .getAllByRole('group')
        .map((group) => group.getAttribute('aria-labelledby'))
        .map((id) => document.getElementById(id ?? '')?.textContent);
const optionsIn = (group: string) =>
    within(screen.getByRole('group', { name: group }))
        .getAllByRole('option')
        .map((option) => option.textContent);

describe('palette matching', () => {
    it('matches every word, ignoring case and accents', () => {
        expect(matchesQuery('nastaveni', ['Nastavení'])).toBe(true);
        expect(matchesQuery('new AGENT', ['New agent'])).toBe(true);
        expect(matchesQuery('new run', ['New agent'])).toBe(false);
        expect(matchesQuery('  ', ['anything'])).toBe(true);
    });

    it('opens on ⌘K and Ctrl+K only', () => {
        const key = { key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
        expect(isPaletteShortcut({ ...key, metaKey: true })).toBe(true);
        expect(isPaletteShortcut({ ...key, ctrlKey: true, key: 'K' })).toBe(true);
        expect(isPaletteShortcut(key)).toBe(false);
        expect(isPaletteShortcut({ ...key, ctrlKey: true, shiftKey: true })).toBe(false);
        expect(isPaletteShortcut({ ...key, ctrlKey: true, key: 'j' })).toBe(false);
    });
});

describe('recent palette picks', () => {
    const member = MemberId.parse(OWNER_ID);

    it('keeps the newest first, each once, at most five', () => {
        const storage = createMemoryStorage();
        for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'b']) rememberPick(storage, member, { kind: 'item', id });

        expect(readRecentPicks(storage, member).map((pick) => pick.id)).toEqual(['b', 'f', 'e', 'd', 'c']);
        expect(readRecentPicks(storage, member)).toHaveLength(MAX_RECENT);
    });

    it('drops entries it cannot read instead of trusting them, and keeps them per member', () => {
        const storage = createMemoryStorage();
        storage.setItem(
            recentStorageKey(member),
            JSON.stringify([{ kind: 'agent', id: 'agent-ada' }, { kind: 'item', id: 'nav:home' }, 'x', null]),
        );
        expect(readRecentPicks(storage, member)).toEqual([{ kind: 'item', id: 'nav:home' }]);

        storage.setItem(recentStorageKey(member), '{not json');
        expect(readRecentPicks(storage, member)).toEqual([]);
        expect(readRecentPicks(storage, MemberId.parse('member-other'))).toEqual([]);
        expect(readRecentPicks(undefined, member)).toEqual([]);
    });
});

describe('command palette', { timeout: TIMEOUT_MS }, () => {
    it.each([
        ['⌘K', '{Meta>}k{/Meta}'],
        ['Ctrl+K', '{Control>}k{/Control}'],
    ])('opens on %s anywhere, closes on Esc and returns focus', async (_label, keys) => {
        const engine = createHomeEngine();
        const { user, container } = renderWithProviders({ path: '/settings', engineApi: engine.client });
        const language = await screen.findByRole('combobox', { name: 'Language' });
        language.focus();

        await user.keyboard(keys);
        const box = await searchBox();
        await waitFor(() => {
            expect(document.activeElement).toBe(box);
        });
        expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeDefined();
        await expectNoAxeViolations(container);

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('combobox', { name: /Search agents/ })).toBeNull();
        expect(document.activeElement).toBe(language);
    });

    it('opens from the header button, the only way in on touch screens', async () => {
        const media = createFakeMatchMedia({ [NARROW_QUERY]: true });
        const { user } = renderWithProviders({ path: '/settings', media, engineApi: createHomeEngine().client });
        const button = await screen.findByRole('button', { name: 'Search and commands' });

        await user.click(button);
        await searchBox();
        await user.keyboard('{Escape}');
        expect(document.activeElement).toBe(button);
    });

    it('finds a seeded agent through the engine and opens it with Enter', async () => {
        const engine = createHomeEngine();
        const { user, router } = renderWithProviders({ path: '/settings', engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));

        await user.type(await searchBox(), 'Grace');
        await waitFor(() => {
            expect(
                within(screen.getByRole('group', { name: 'Agents' }))
                    .getAllByRole('option')
                    .map((option) => option.textContent),
            ).toEqual(['GraceReview']);
        });
        expect(options()[0]).toBe('GraceReview');
        await waitFor(() => {
            expect(engine.spies.agents).toHaveBeenLastCalledWith(
                expect.objectContaining({ q: 'Grace' }),
                expect.anything(),
            );
        });
        await user.keyboard('{Enter}');
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/agents/agent-grace');
        });
        expect(screen.queryByRole('combobox', { name: /Search agents/ })).toBeNull();
    });

    it('waits for typing to pause and aborts the request it no longer needs', async () => {
        const engine = createHomeEngine();
        const answering = createHomeEngine().client.agents;
        const signals: AbortSignal[] = [];
        engine.spies.agents.mockImplementation((query, signal) => {
            signals.push(signal);
            if (query.q !== 'Ad') return answering.list(query, signal);
            return new Promise((_, reject) => {
                signal.addEventListener('abort', () => {
                    reject(new Error('aborted'));
                });
            });
        });
        const { user } = renderWithProviders({ path: '/settings', engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        const box = await searchBox();

        await user.type(box, 'Ad');
        await waitFor(() => {
            expect(engine.spies.agents.mock.calls.some(([query]) => query.q === 'Ad')).toBe(true);
        });
        expect(engine.spies.agents.mock.calls.some(([query]) => query.q === 'A')).toBe(false);
        const pending = signals.at(-1);
        await user.type(box, 'a');
        await waitFor(() => {
            expect(pending?.aborted).toBe(true);
        });
        expect(await screen.findByRole('option', { name: /^Ada/ })).toBeDefined();
    });

    it('preloads an agent when its option becomes active', async () => {
        const engine = createHomeEngine();
        const agents = { ...engine.client.agents };
        const get = vi.spyOn(agents, 'get');
        const { user } = renderWithProviders({ path: '/settings', engineApi: { ...engine.client, agents } });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'Iris');
        await screen.findByRole('option', { name: /^Iris/ });

        expect(get).not.toHaveBeenCalled();
        await user.keyboard('{ArrowDown}{ArrowUp}');
        await waitFor(() => {
            expect(get).toHaveBeenCalledWith('agent-iris', expect.anything());
        });
    });

    it('lists places and commands the member may use, and leaves out a command whose permission is missing', async () => {
        const custom = defineFeature({
            id: 'custom',
            requires: {},
            commands: [
                { id: 'custom.run', label: () => 'Ring the bell', keywords: () => ['bell'], run: vi.fn() },
                {
                    id: 'custom.guarded',
                    label: () => 'Erase everything',
                    keywords: () => [],
                    to: '/settings',
                    requires: { permission: 'members.manage' },
                },
            ],
        });
        const engine = createHomeEngine({ permissions: allBut('agents.write', 'members.manage') });
        const { user } = renderWithProviders({
            path: '/settings',
            engineApi: engine.client,
            features: [...FEATURES, custom],
        });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await searchBox();

        const navigation = screen.getByRole('group', { name: 'Go to' });
        expect(
            within(navigation)
                .getAllByRole('option')
                .map((option) => option.textContent),
        ).toContain('Home');
        const commands = screen.getByRole('group', { name: 'Commands' });
        const commandLabels = within(commands)
            .getAllByRole('option')
            .map((option) => option.textContent);
        expect(commandLabels).toContain('Ring the bell');
        expect(commandLabels).toContain('Passkeys');
        expect(commandLabels).not.toContain('Erase everything');
        expect(commandLabels).not.toContain('New agent');

        const run = custom.commands[0].run;
        await user.type(await searchBox(), 'bell');
        await waitFor(() => {
            expect(options()).toEqual(['Ring the bell']);
        });
        await user.keyboard('{Enter}');
        expect(run).toHaveBeenCalledOnce();
    });

    it('offers "New agent" with agents.write and goes there', async () => {
        const { user, router } = renderWithProviders({ path: '/settings', engineApi: createHomeEngine().client });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'new agent');

        await screen.findByRole('option', { name: 'New agent' });
        expect(options()[0]).toBe('New agent');
        await user.keyboard('{Enter}');
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/agents/new');
        });
    });

    it('takes a command to its view with the search params it names', async () => {
        const { user, router } = renderWithProviders({ path: '/settings', engineApi: createHomeEngine().client });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'pause trigger');

        await screen.findByRole('option', { name: 'Pause trigger' });
        await user.keyboard('{Enter}');
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/triggers');
        });
        expect(router.state.location.search).toMatchObject({ lifecycle: 'active' });
    });

    it('finds a run by its ID and stops it with runs.control', async () => {
        const engine = createHomeEngine();
        const { user } = renderWithProviders({ path: '/settings', engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), RUN_IDS.running);

        const runs = await screen.findByRole('group', { name: 'Runs' });
        await waitFor(() => {
            expect(within(runs).getAllByRole('option')).toHaveLength(2);
        });
        const stop = within(runs).getByRole('option', { name: /^Stop run:/ });
        await user.click(stop);
        await waitFor(() => {
            expect(engine.spies.runCancel).toHaveBeenCalledWith(RUN_IDS.running, expect.anything());
        });
    });

    it('looks up a run that is not among the recent ones, and offers no stop without runs.control', async () => {
        const engine = createHomeEngine({ permissions: allBut('runs.control') });
        const { user, router } = renderWithProviders({ path: '/settings', engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'run-old-050');

        const runs = await screen.findByRole('group', { name: 'Runs' });
        await waitFor(() => {
            expect(engine.spies.runGet).toHaveBeenCalledWith('run-old-050', expect.anything());
        });
        const open = await within(runs).findByRole('option', { name: /^Open run: Nightly import 50/ });
        expect(within(runs).queryByRole('option', { name: /^Stop run:/ })).toBeNull();
        await user.click(open);
        await waitFor(() => {
            expect(router.state.location.pathname).toBe('/runs/run-old-050');
        });
    });

    it('shows a short label in the sidebar and keeps the full name', async () => {
        renderWithProviders({ path: '/settings', engineApi: createHomeEngine().client });
        const button = await screen.findByRole('button', { name: 'Search and commands' });
        const visible = button.querySelector(':scope > span[aria-hidden="true"]');
        expect(visible?.textContent).toBe('Search');
    });

    it('opens on agents, then places in the sidebar order, with a short placeholder and key hints', async () => {
        const { user } = renderWithProviders({ path: '/settings', engineApi: createHomeEngine().client });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        const box = await searchBox();

        expect(box.getAttribute('placeholder')).toBe('Search or jump to…');
        await waitFor(() => {
            expect(groupNames().slice(0, 2)).toEqual(['Agents', 'Go to']);
        });
        const places = optionsIn('Go to');
        expect(places.slice(0, 9)).toEqual([
            'Home',
            'Inbox',
            'Agents',
            'Chats',
            'Tasks',
            'Runs',
            'Files',
            'Triggers',
            'Integrations',
        ]);
        expect(screen.getByText('Esc').closest('[aria-hidden="true"]')).not.toBeNull();
    });

    it('leads with what the member picked last, kept across visits', async () => {
        const first = renderWithProviders({ path: '/settings', engineApi: createHomeEngine().client });
        await first.user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await first.user.type(await searchBox(), 'Grace');
        await screen.findByRole('option', { name: /^Grace/ });
        await first.user.keyboard('{Enter}');
        await first.user.click(screen.getByRole('button', { name: 'Search and commands' }));
        await first.user.type(await searchBox(), 'triggers');
        await waitFor(() => {
            expect(options()[0]).toBe('Triggers');
        });
        await first.user.keyboard('{Enter}');
        await waitFor(() => {
            expect(first.router.state.location.pathname).toBe('/triggers');
        });
        first.unmount();

        const second = renderWithProviders({
            path: '/settings',
            engineApi: createHomeEngine().client,
            storage: first.storage,
        });
        await second.user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await searchBox();
        expect(groupNames()[0]).toBe('Recent');
        expect(optionsIn('Recent')).toEqual(['Triggers', 'Grace']);
        expect(optionsIn('Go to')).not.toContain('Triggers');

        await second.user.type(await searchBox(), 'tri');
        await waitFor(() => {
            expect(groupNames()).not.toContain('Recent');
        });
        expect(optionsIn('Go to')).toContain('Triggers');
    });

    it('leaves out a recent place the member may no longer open', async () => {
        const storage = createMemoryStorage();
        rememberPick(storage, MemberId.parse('member-owner'), { kind: 'item', id: 'nav:members' });
        const engine = createHomeEngine({ permissions: allBut('members.read') });
        const { user } = renderWithProviders({ path: '/settings', engineApi: engine.client, storage });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await searchBox();

        expect(groupNames()).not.toContain('Recent');
        expect(options()).not.toContain('Members');
    });

    it('switches the theme and the language in one step, offering only a change', async () => {
        const { user } = renderWithProviders({ path: '/settings', engineApi: createHomeEngine().client });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'theme');
        await waitFor(() => {
            expect(options()).toEqual(['Theme: Light', 'Theme: Dark']);
        });
        await user.click(screen.getByRole('option', { name: 'Theme: Dark' }));
        expect(document.documentElement.classList.contains('dark')).toBe(true);

        await user.click(screen.getByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'jazyk');
        await screen.findByRole('option', { name: 'Language: Čeština' });
        await user.keyboard('{Enter}');
        expect(await screen.findByRole('button', { name: 'Hledat a příkazy' })).toBeDefined();
        expect(document.documentElement.lang).toBe('cs');
    });

    it('collapses the sidebar', async () => {
        const { user } = renderWithProviders({ path: '/settings', engineApi: createHomeEngine().client });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'sidebar');
        await user.click(await screen.findByRole('option', { name: 'Collapse sidebar' }));
        expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeDefined();
    });

    it('offers no sidebar command in the narrow layout, where the drawer has none', async () => {
        const media = createFakeMatchMedia({ [NARROW_QUERY]: true });
        const engine = createHomeEngine();
        const { user } = renderWithProviders({ path: '/settings', media, engineApi: engine.client });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'sidebar');
        await waitFor(() => {
            expect(engine.spies.agents).toHaveBeenLastCalledWith(
                expect.objectContaining({ q: 'sidebar' }),
                expect.anything(),
            );
        });
        expect(options()).toEqual([]);
    });

    it('signs out at the gateway', async () => {
        const { user, fetch, location } = renderWithProviders({
            path: '/settings',
            engineApi: createHomeEngine().client,
        });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'log out');
        await user.click(await screen.findByRole('option', { name: 'Sign out' }));
        await waitFor(() => {
            expect(location.assign).toHaveBeenCalledWith(SIGN_IN_PATH);
        });
        expect(fetch).toHaveBeenCalledWith(SIGN_OUT_PATH, expect.objectContaining({ method: 'POST' }));
    });

    it('opens "Add login" over the Wallet with wallet.manage, and drops the request when it closes', async () => {
        const { user, router } = renderWithProviders({ path: '/settings', engineApi: walletPaletteEngine() });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'add login');
        await user.click(await screen.findByRole('option', { name: 'Add login' }));

        const dialog = await screen.findByRole('dialog', { name: 'Add login' });
        expect(router.state.location.search).toMatchObject({ dialog: 'new' });
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => {
            expect(router.state.location.search).not.toHaveProperty('dialog');
        });
        expect(screen.queryByRole('dialog', { name: 'Add login' })).toBeNull();
    });

    it('offers no "Add login" without wallet.manage, and the Wallet ignores the request', async () => {
        const { user } = renderWithProviders({
            path: '/settings',
            engineApi: walletPaletteEngine(allBut('wallet.manage')),
        });
        await user.click(await screen.findByRole('button', { name: 'Search and commands' }));
        await user.type(await searchBox(), 'add login');
        await waitFor(() => {
            expect(options()).not.toContain('Add login');
        });

        renderWithProviders({ path: '/wallet?dialog=new', engineApi: walletPaletteEngine(allBut('wallet.manage')) });
        expect(await screen.findByRole('heading', { name: 'Wallet', level: 1 })).toBeDefined();
        expect(screen.queryByRole('dialog', { name: 'Add login' })).toBeNull();
    });
});

function walletPaletteEngine(permissions?: readonly Permission[]) {
    return createSecurityEngine(permissions === undefined ? {} : { permissions }).client;
}
