import { PERMISSIONS } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FEATURES } from '../../../app/features';
import { defineFeature } from '../../../app/registry/feature';
import { expectNoAxeViolations } from '../../../testing/axe';
import { createFakeMatchMedia } from '../../../testing/fake-match-media';
import { createHomeEngine } from '../../../testing/home-engine';
import { renderWithProviders } from '../../../testing/render-with-providers';
import { RUN_IDS } from '../../../testing/runs-engine';
import { NARROW_QUERY } from '../use-media-query';
import { isPaletteShortcut } from './palette-launcher';
import { matchesQuery } from './palette-match';

const TIMEOUT_MS = 20_000;
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));

const searchBox = () => screen.findByRole('combobox', { name: 'Search agents, runs, pages and commands' });
const options = () =>
    within(screen.getByRole('listbox'))
        .queryAllByRole('option')
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
});
