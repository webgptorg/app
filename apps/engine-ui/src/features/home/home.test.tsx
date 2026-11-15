import { createProblem, PERMISSIONS, SemVer } from '@ptbk/engine-api';
import type { ActivityItem, ActivityPageRead, EngineApiClient, EngineApiResponse, Permission } from '@ptbk/engine-api';
import { createDemoSeed, createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngineApiOptions } from '@ptbk/engine-api/in-memory';
import { setMedia } from '@ptbk/ui';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FEATURES } from '../../app/features';
import { defineFeature } from '../../app/registry/feature';
import { expectNoAxeViolations } from '../../testing/axe';
import { createHomeEngine, seededActivity } from '../../testing/home-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { HOSTILE } from '../../testing/runs-engine';
import { problemResponse, TEST_NOW } from '../../testing/test-engine-api';

const TIMEOUT_MS = 20_000;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const allBut = (...missing: readonly Permission[]) => PERMISSIONS.filter((permission) => !missing.includes(permission));
const Icon = () => null;

afterEach(() => {
    setMedia(REDUCED_MOTION, false);
});

const feed = () => screen.findByRole('region', { name: /^Recent activity/ });

/** Opens the whole feed in place: Home shows its newest rows until the reader asks for all of it. */
async function openAll(user: { readonly click: (element: Element) => Promise<void> }, region: HTMLElement) {
    await user.click(await within(region).findByRole('button', { name: 'All activity' }));
}
const liveRegion = () => document.querySelector('[aria-live="polite"].sr-only');

function memberJoined(n: number) {
    return {
        kind: 'member.joined' as const,
        agentId: null,
        actor: { kind: 'system' as const },
        memberId: `member-live-${String(n)}`,
        displayName: `Live member ${String(n)}`,
    };
}

function page(items: readonly ActivityItem[]): Promise<EngineApiResponse<ActivityPageRead>> {
    return Promise.resolve({
        kind: 'ok',
        data: { items, nextCursor: null, dropped: 0 },
    } as EngineApiResponse<ActivityPageRead>);
}

const base = {
    id: 'activity-x',
    at: new Date(TEST_NOW.getTime() - 60_000).toISOString(),
    agentId: 'agent-ada',
    agentName: 'Ada',
    actor: { kind: 'system' },
} as const;

function demoEngine(options: InMemoryEngineApiOptions = {}): EngineApiClient {
    return createInMemoryEngineApiClient({
        clock: { now: () => TEST_NOW },
        seed: createDemoSeed(TEST_NOW),
        ...options,
    });
}

// A section's name is its title and, when it has one, its count.
const needsYou = () => screen.findByRole('region', { name: /^Needs you/ });
const workingNow = () => screen.findByRole('region', { name: /^Working now/ });

describe('home', { timeout: TIMEOUT_MS }, () => {
    it('greets the owner, leads with Ask Chatter, ends with recent activity and meets axe', async () => {
        const engine = createHomeEngine();
        const { container } = renderWithProviders({ path: '/', engineApi: engine.client });

        expect(await screen.findByRole('heading', { level: 1, name: /, Owner$/ })).toBeDefined();
        // Home's content arrives as a chunk of its own, alongside the data.
        expect(await screen.findByRole('textbox', { name: 'Ask Chatter' })).toBeDefined();
        expect(screen.getByRole('link', { name: 'New agent' }).getAttribute('href')).toBe('/agents/new');
        expect(await within(await feed()).findAllByRole('listitem')).not.toHaveLength(0);
        expect(await screen.findByRole('region', { name: 'Recent chats' })).toBeDefined();
        await expectNoAxeViolations(container);
    });

    it('asks Chatter: starts a chat with Chatter, sends the words and opens the thread', async () => {
        const engineApi = demoEngine();
        const create = vi.spyOn(engineApi.chats, 'create');
        const send = vi.spyOn(engineApi.chats, 'sendMessage');
        const { user, router } = renderWithProviders({ path: '/', engineApi });

        await user.type(await screen.findByRole('textbox', { name: 'Ask Chatter' }), 'Draft the launch post{Enter}');
        await waitFor(() => {
            expect(router.state.location.pathname).toMatch(/^\/chats\/./);
        });
        expect(create.mock.calls[0]?.[0]).not.toHaveProperty('agentId');
        const chatId = router.state.location.pathname.split('/').at(-1);
        expect(send).toHaveBeenCalledWith(
            chatId,
            expect.objectContaining({ content: 'Draft the launch post' }),
            expect.anything(),
        );
    });

    it('keeps the words and says why when the chat cannot start, then tries again without a second thread', async () => {
        const engineApi = demoEngine();
        const create = vi
            .spyOn(engineApi.chats, 'create')
            .mockImplementationOnce(() => problemResponse('chatter-missing'))
            .mockImplementationOnce(() => Promise.reject(new Error('offline')));
        const { user, router } = renderWithProviders({ path: '/', engineApi });

        const box = await screen.findByRole('textbox', { name: 'Ask Chatter' });
        await user.type(box, 'Hello{Enter}');
        expect(await screen.findByText(/Chatter isn’t set up on this engine yet/)).toBeDefined();
        expect((box as HTMLTextAreaElement).value).toBe('Hello');

        await user.type(box, '{Enter}');
        await screen.findByText('Your message was not sent');
        await user.type(box, '{Enter}');
        await waitFor(() => {
            expect(router.state.location.pathname).toMatch(/^\/chats\/./);
        });
        // The try without an answer and the retry share a request key: the engine opens one thread for both.
        expect(create.mock.calls[2]?.[0].requestKey).toBe(create.mock.calls[1]?.[0].requestKey);
    });

    it('keeps the words when the message is refused, and sends them again into the same new chat', async () => {
        const engineApi = demoEngine();
        const create = vi.spyOn(engineApi.chats, 'create');
        const send = vi
            .spyOn(engineApi.chats, 'sendMessage')
            .mockImplementationOnce(() => problemResponse('forbidden'));
        const { user, router } = renderWithProviders({ path: '/', engineApi });

        const box = await screen.findByRole('textbox', { name: 'Ask Chatter' });
        await user.type(box, 'Summarise the week{Enter}');
        await waitFor(() => {
            expect(send).toHaveBeenCalledTimes(1);
        });
        expect((box as HTMLTextAreaElement).value).toBe('Summarise the week');
        await user.type(box, '{Enter}');
        await waitFor(() => {
            expect(router.state.location.pathname).toMatch(/^\/chats\/./);
        });
        expect(create).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[1]?.[0]).toBe(send.mock.calls[0]?.[0]);
    });

    it('keeps a failing chat list to its own section, and shows a thread with no agent by its icon', async () => {
        const engine = createHomeEngine();
        engine.spies.chats.mockResolvedValue({ kind: 'problem', problem: createProblem('validation-failed') });
        const { unmount } = renderWithProviders({ path: '/', engineApi: engine.client });
        const recent = await screen.findByRole('region', { name: 'Recent chats' });
        expect(await within(recent).findByText('This part of the page could not load.')).toBeDefined();
        unmount();

        const lonely = createHomeEngine();
        lonely.spies.chats.mockImplementation(async (query, signal) => {
            const chats = await lonely.client.chats.list('agent-ada' as never, query, signal);
            return chats.kind === 'ok'
                ? {
                      ...chats,
                      data: { ...chats.data, items: chats.data.items.map((chat) => ({ ...chat, members: [] })) },
                  }
                : chats;
        });
        renderWithProviders({ path: '/', engineApi: lonely.client });
        const list = await screen.findByRole('region', { name: 'Recent chats' });
        expect((await within(list).findAllByRole('link')).length).toBeGreaterThan(1);
    });

    it('tries a start the engine may have done again under the same key, and says a refused message plainly', async () => {
        const engineApi = demoEngine();
        const create = vi.spyOn(engineApi.chats, 'create').mockImplementationOnce(() => problemResponse('unavailable'));
        const send = vi
            .spyOn(engineApi.chats, 'sendMessage')
            .mockImplementationOnce(() => problemResponse('unavailable'));
        const { user, router } = renderWithProviders({ path: '/', engineApi });

        const box = await screen.findByRole('textbox', { name: 'Ask Chatter' });
        await user.type(box, 'Plan the week{Enter}');
        expect(await screen.findByText('The chat didn’t start. Try again.')).toBeDefined();
        await user.type(box, '{Enter}');
        await waitFor(() => {
            expect(send).toHaveBeenCalledTimes(1);
        });
        await user.type(box, '{Enter}');
        await waitFor(() => {
            expect(router.state.location.pathname).toMatch(/^\/chats\/./);
        });
        expect(create.mock.calls[1]?.[0].requestKey).toBe(create.mock.calls[0]?.[0].requestKey);
        expect(send.mock.calls[1]?.[1].requestKey).toBe(send.mock.calls[0]?.[1].requestKey);
    });

    it('offers no composer without chats.write, no chats without chats.read, and no feed without oversight', async () => {
        const engine = createHomeEngine({ permissions: allBut('security.read', 'chats.write') });
        const { unmount } = renderWithProviders({ path: '/', engineApi: engine.client });
        await screen.findByRole('region', { name: 'Recent chats' });
        expect(screen.queryByRole('textbox', { name: 'Ask Chatter' })).toBeNull();
        expect(screen.queryByRole('region', { name: /^Recent activity/ })).toBeNull();
        unmount();

        const reader = createHomeEngine({ permissions: ['agents.read', 'runs.read'] });
        renderWithProviders({ path: '/', engineApi: reader.client });
        await workingNow();
        expect(screen.queryByRole('region', { name: 'Recent chats' })).toBeNull();
        expect(reader.spies.chats).not.toHaveBeenCalled();
    });

    it('quotes an agent’s question with Reply, and puts every count that waits on the member on one line each', async () => {
        renderWithProviders({ path: '/', engineApi: demoEngine() });
        const region = await needsYou();
        expect(await within(region).findByText('Iris asks you')).toBeDefined();
        expect(
            await within(region).findByText('Should the weekly report include the three open support cases?'),
        ).toBeDefined();
        expect(within(region).getByRole('link', { name: 'Reply' }).getAttribute('href')).toBe(
            '/chats/chat-iris-question',
        );
        const login = await within(region).findByText('2 login requests waiting');
        expect(
            within(login.closest('li') ?? region)
                .getByRole('link', { name: 'Review' })
                .getAttribute('href'),
        ).toBe('/wallet');
        expect(await within(region).findByText('1 person asks to join')).toBeDefined();
        const failed = await within(region).findByText(/failed run/);
        expect(
            within(failed.closest('li') ?? region)
                .getByRole('link', { name: 'Review' })
                .getAttribute('href'),
        ).toBe('/runs?status=failed');
    });

    it('names a provider’s count by its label, else by its nav label, linking to exactly what it counts', async () => {
        const audit = defineFeature({
            id: 'fake-audit',
            requires: {},
            attention: {
                id: 'audit',
                useAttention: () => ({ count: 2, to: '/audit' }),
                label: (n) => `${String(n)} to review`,
            },
        });
        const secrets = defineFeature({
            id: 'fake-secrets',
            requires: {},
            nav: { group: 'admin', order: 99, label: () => 'Vault', icon: Icon, to: '/wallet' },
            attention: { id: 'secrets', useAttention: () => ({ count: 3, to: '/wallet', search: { dialog: 'new' } }) },
        });
        const engine = createHomeEngine({ seed: { runs: [] } });
        renderWithProviders({ path: '/', engineApi: engine.client, features: [...FEATURES, audit, secrets] });

        const region = await needsYou();
        const review = await within(region).findByText('2 to review');
        expect(
            within(review.closest('li') ?? region)
                .getByRole('link', { name: 'Review' })
                .getAttribute('href'),
        ).toBe('/audit');
        const vault = await within(region).findByText('Vault: 3');
        expect(
            within(vault.closest('li') ?? region)
                .getByRole('link', { name: 'Review' })
                .getAttribute('href'),
        ).toBe('/wallet?dialog=new');
    });

    it('shows agents replying with their latest step and a timer, running tasks and runs that are neither', async () => {
        renderWithProviders({ path: '/', engineApi: demoEngine() });

        const region = await workingNow();
        expect(await within(region).findByText('Chatter is replying in')).toBeDefined();
        expect(within(region).getByRole('link', { name: 'Release notes' }).getAttribute('href')).toBe(
            '/chats/chat-working',
        );
        expect(await within(region).findByRole('link', { name: 'Ship billing v2' })).toBeDefined();
        expect(within(region).getByText('Waiting for the invoice migration')).toBeDefined();
        expect(await within(region).findByRole('link', { name: 'Answer a refund request' })).toBeDefined();
        expect(within(region).getAllByText(/^\d+:\d\d$/).length).toBeGreaterThanOrEqual(2);
    });

    it('says in one quiet line each that nothing waits and nothing runs', async () => {
        const engine = createHomeEngine({ activity: [], seed: { agents: [], runs: [], chats: [], tasks: [] } });
        renderWithProviders({ path: '/', engineApi: engine.client, features: FEATURES });

        expect(await within(await needsYou()).findByText('Nothing waits on you.')).toBeDefined();
        expect(await within(await workingNow()).findByText('Nothing is running right now.')).toBeDefined();
        const chats = await screen.findByRole('region', { name: 'Recent chats' });
        expect(await within(chats).findByText('Your conversations with agents show up here.')).toBeDefined();
    });

    it('never calls a member’s home quiet while a count is still unknown', async () => {
        const slow = defineFeature({
            id: 'fake-slow',
            requires: {},
            attention: { id: 'slow', useAttention: () => ({ count: 0, to: '/audit', pending: true }) },
        });
        const engine = createHomeEngine({ activity: [], seed: { agents: [], runs: [], chats: [] } });
        renderWithProviders({ path: '/', engineApi: engine.client, features: [...FEATURES, slow] });

        const region = await needsYou();
        await screen.findByText('Nothing is running right now.');
        expect(within(region).queryByText('Nothing waits on you.')).toBeNull();
    });

    it('lists recent chats with their agents, a calm preview and the time, naming an untitled one by its words', async () => {
        const engine = createHomeEngine();
        engine.spies.chats.mockImplementation(async (query, signal) => {
            const chats = await engine.client.chats.list('agent-ada' as never, query, signal);
            return chats.kind === 'ok'
                ? {
                      ...chats,
                      data: {
                          ...chats.data,
                          items: chats.data.items.flatMap((chat) => [
                              { ...chat, title: ' ', preview: 'Plan the launch' },
                              { ...chat, id: `${chat.id}-untitled` as never, title: ' ', preview: null },
                              { ...chat, id: `${chat.id}-marked` as never, preview: '+@User Which {Ship it} first?' },
                          ]),
                      },
                  }
                : chats;
        });
        renderWithProviders({ path: '/', engineApi: engine.client });

        const recent = await screen.findByRole('region', { name: 'Recent chats' });
        expect(await within(recent).findByRole('link', { name: /^Plan the launch/ })).toBeDefined();
        expect(within(recent).getByRole('link', { name: /^Untitled chat/ })).toBeDefined();
        expect(within(recent).getByText('Which Ship it first?')).toBeDefined();
        expect(within(recent).getByRole('link', { name: 'All chats' }).getAttribute('href')).toBe('/chats');
    });

    it('renders agents’ questions and chat titles as text, never markup', async () => {
        const seed = createDemoSeed(TEST_NOW);
        const chats = (seed.chats ?? []).map((chat) =>
            chat.id === 'chat-iris-question'
                ? {
                      ...chat,
                      title: HOSTILE,
                      entries: chat.entries.map((entry) =>
                          entry.type === 'message' && entry.content.startsWith('+@User')
                              ? { ...entry, content: `+@User ${HOSTILE}` }
                              : entry,
                      ),
                  }
                : chat,
        );
        const engineApi = createInMemoryEngineApiClient({ clock: { now: () => TEST_NOW }, seed: { ...seed, chats } });
        const { container } = renderWithProviders({ path: '/', engineApi });

        const region = await needsYou();
        expect(await within(region).findAllByText(HOSTILE)).toHaveLength(2);
        expect(container.querySelector('img[src="x"], script')).toBeNull();
    });

    it('shows the update banner when GET /security says one is available', async () => {
        const engine = createHomeEngine();
        const current = await engine.client.security.get(AbortSignal.timeout(1000));
        if (current.kind !== 'ok') throw new Error('no security overview');
        engine.controller.updateSecurity({
            update: {
                ...current.data.update,
                status: 'available',
                availableVersion: '9.1.0',
                eligibleAt: '2026-10-02T12:00:00.000Z',
            },
        });
        renderWithProviders({ path: '/', engineApi: engine.client });

        const banner = await screen.findByText(/Version 9\.1\.0 can be installed from/);
        expect(banner).toBeDefined();
        expect(screen.getByRole('link', { name: 'Review the update' }).getAttribute('href')).toBe('/settings');
    });

    it('shows the update banner on an engine.update-available event', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        await feed();
        expect(screen.queryByText('Engine update available')).toBeNull();

        act(() => {
            engine.controller.appendActivity({
                kind: 'engine.update-available',
                agentId: null,
                actor: { kind: 'system' },
                version: SemVer.parse('9.2.0'),
            });
        });
        expect(await screen.findByText('Version 9.2.0 is available.')).toBeDefined();
        // The feed's live region repeats the line once its announcer flushes, so look for the card in the list only.
        const list = within(await feed()).getByRole('list');
        expect(await within(list).findByText('Engine version 9.2.0 is available')).toBeDefined();
        await waitFor(() => {
            expect(liveRegion()?.textContent).toBe('Engine version 9.2.0 is available');
        });
    });

    it('takes the banner down once the engine says it installed the update', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        await feed();
        act(() => {
            engine.controller.appendActivity({
                kind: 'engine.update-available',
                agentId: null,
                actor: { kind: 'system' },
                version: SemVer.parse('9.2.0'),
            });
        });
        expect(await screen.findByText('Version 9.2.0 is available.')).toBeDefined();

        act(() => {
            engine.controller.appendActivity({
                kind: 'engine.updated',
                agentId: null,
                actor: { kind: 'system' },
                fromVersion: SemVer.parse('9.1.0'),
                toVersion: SemVer.parse('9.2.0'),
            });
        });
        await waitFor(() => {
            expect(screen.queryByText('Version 9.2.0 is available.')).toBeNull();
        });
    });

    it('shows a feed that fails with a retry, and the rest of home still renders', async () => {
        const engine = createHomeEngine();
        engine.spies.activity.mockImplementation(() =>
            Promise.resolve({ kind: 'problem', problem: createProblem('forbidden') }),
        );
        renderWithProviders({ path: '/', engineApi: engine.client });

        expect(await within(await feed()).findByText('Activity could not load.')).toBeDefined();
        expect(await screen.findByRole('region', { name: 'Recent chats' })).toBeDefined();
    });
});

describe('home: activity feed', { timeout: TIMEOUT_MS }, () => {
    it('puts an emitted activity on top without asking the engine again', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        await within(region).findAllByRole('listitem');
        const calls = engine.spies.activity.mock.calls.length;

        act(() => {
            engine.controller.appendActivity(memberJoined(1));
        });
        const items = await within(region).findAllByRole('listitem');
        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')[0]?.textContent).toContain('Live member 1');
        });
        expect(items.length).toBeGreaterThan(1);
        expect(engine.spies.activity.mock.calls.length).toBe(calls);
    });

    it('collects new items behind "N new" while the reader is scrolled down', async () => {
        const engine = createHomeEngine();
        const { user } = renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        await within(region).findAllByRole('listitem');
        await openAll(user, region);
        const before = within(region).getAllByRole('listitem').length;
        const sentinel = region.querySelector('[data-activity-top]') as HTMLElement;
        sentinel.getBoundingClientRect = () => ({ top: -400 }) as DOMRect;
        act(() => {
            window.dispatchEvent(new Event('scroll'));
        });

        act(() => {
            engine.controller.appendActivity(memberJoined(1));
            engine.controller.appendActivity(memberJoined(2));
        });
        const more = await within(region).findByRole('button', { name: '2 new items' });
        expect(within(region).getAllByRole('listitem')).toHaveLength(before);
        expect(within(region).queryByText('Live member 2')).toBeNull();

        await user.click(more);
        expect(within(region).getAllByRole('listitem')).toHaveLength(before + 2);
        expect(within(region).getAllByRole('listitem')[0]?.textContent).toContain('Live member 2');
    });

    it('announces a batch of arrivals once, in one polite live region', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        await within(await feed()).findAllByRole('listitem');
        expect(document.querySelectorAll('[aria-live="polite"].sr-only')).toHaveLength(1);
        expect(liveRegion()?.textContent).toBe('');

        act(() => {
            engine.controller.appendActivity(memberJoined(1));
            engine.controller.appendActivity(memberJoined(2));
            engine.controller.appendActivity(memberJoined(3));
        });
        await waitFor(() => {
            expect(liveRegion()?.textContent).toBe('3 new activities');
        });
    });

    it('announces a single arrival by its summary', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        await within(await feed()).findAllByRole('listitem');

        act(() => {
            engine.controller.appendActivity(memberJoined(7));
        });
        await waitFor(() => {
            expect(liveRegion()?.textContent).toBe('Live member 7 joined');
        });
    });

    it('slides new items in, and only fades them under reduced motion', async () => {
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        await within(region).findAllByRole('listitem');
        expect(within(region).getAllByRole('listitem')[0]?.className).not.toMatch(/ptbk-activity/);

        act(() => {
            engine.controller.appendActivity(memberJoined(1));
        });
        await within(region).findByText('Live member 1');
        expect(within(region).getAllByRole('listitem')[0]?.className).toMatch(/ptbk-activity-enter/);

        act(() => {
            setMedia(REDUCED_MOTION, true);
            engine.controller.appendActivity(memberJoined(2));
        });
        await within(region).findByText('Live member 2');
        const first = within(region).getAllByRole('listitem')[0]?.className ?? '';
        expect(first).toMatch(/ptbk-activity-fade/);
        expect(first).not.toMatch(/ptbk-activity-enter/);
    });

    it('filters by area with chips bound to the URL, offering only visible areas', async () => {
        const engine = createHomeEngine();
        const { user, router } = renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        expect(within(region).queryByRole('group', { name: 'Show activity of' })).toBeNull();
        await openAll(user, region);
        const chips = within(await within(region).findByRole('group', { name: 'Show activity of' })).getAllByRole(
            'button',
        );
        expect(chips.map((chip) => chip.textContent)).toEqual([
            'All',
            'Runs',
            'Files',
            'Triggers',
            'Integrations',
            'Members',
            'Engine',
        ]);

        await user.click(within(region).getByRole('button', { name: 'Members' }));
        await waitFor(() => {
            expect(router.state.location.search).toEqual({ activity: 'member' });
        });
        expect(engine.spies.activity).toHaveBeenLastCalledWith(
            expect.objectContaining({ kind: 'member.' }),
            expect.anything(),
        );
        expect(within(region).getByRole('button', { name: 'Members' }).getAttribute('aria-pressed')).toBe('true');

        act(() => {
            engine.controller.appendActivity(memberJoined(4));
        });
        expect(await within(region).findByText('Live member 4')).toBeDefined();
        await user.click(within(region).getByRole('button', { name: 'All' }));
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
    });

    it('keeps the filters on an area with nothing in it, so the way back stays', async () => {
        const engine = createHomeEngine({ activity: [] });
        const { user } = renderWithProviders({ path: '/?activity=engine', engineApi: engine.client });
        const region = await feed();

        expect(await within(region).findByText('Nothing of this kind yet.')).toBeDefined();
        await user.click(within(region).getByRole('button', { name: 'All' }));
        expect(await within(region).findByText('No activity yet')).toBeDefined();
        expect(within(region).queryByRole('group', { name: 'Show activity of' })).toBeNull();
    });

    it('shows a member without runs.read no run cards and no run chip, even from a careless engine', async () => {
        const engine = createHomeEngine({ permissions: allBut('runs.read') });
        const run = { ...base, kind: 'run.started', v: 1, runId: 'run-completed', source: 'web' };
        engine.spies.activity.mockImplementation(() =>
            page([
                { kind: 'known', activity: run as never },
                { kind: 'known', activity: { ...base, id: 'activity-m', v: 1, ...memberJoined(9) } as never },
            ]),
        );
        renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();

        expect(await within(region).findByText('Live member 9')).toBeDefined();
        expect(within(region).getAllByRole('listitem')).toHaveLength(1);
        expect(within(region).queryByRole('button', { name: 'Runs' })).toBeNull();
    });

    it('loads older pages on demand', async () => {
        const engine = createHomeEngine({ activity: seededActivity(25) });
        const { user } = renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')).toHaveLength(8);
        });
        await openAll(user, region);
        expect(within(region).getAllByRole('listitem')).toHaveLength(20);

        await user.click(within(region).getByRole('button', { name: 'Load older' }));
        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')).toHaveLength(25);
        });
        expect(within(region).queryByRole('button', { name: 'Load older' })).toBeNull();
    });
});

describe('home: older activity', { timeout: TIMEOUT_MS }, () => {
    it('offers a retry when older activity cannot load', async () => {
        const engine = createHomeEngine({ activity: seededActivity(25) });
        const { user } = renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();
        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')).toHaveLength(8);
        });
        await openAll(user, region);
        expect(within(region).getAllByRole('listitem')).toHaveLength(20);
        engine.spies.activity.mockImplementationOnce(() =>
            Promise.resolve({ kind: 'problem', problem: createProblem('forbidden') }),
        );

        await user.click(within(region).getByRole('button', { name: 'Load older' }));
        expect(await within(region).findByText('Older activity could not load.')).toBeDefined();
        await user.click(within(region).getByRole('button', { name: 'Try again' }));
        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')).toHaveLength(25);
        });
    });
});

describe('home: activity cards', { timeout: TIMEOUT_MS }, () => {
    it('gives an unknown kind, a higher version and an invalid item the generic card with the raw kind as text', async () => {
        const engine = createHomeEngine();
        engine.spies.activity.mockImplementation(() =>
            page([
                {
                    kind: 'unknown',
                    base: { ...base, id: 'a-1', kind: 'deploy.started', v: 1 } as never,
                    raw: { secret: 'payload-1' },
                },
                {
                    kind: 'unknown',
                    base: { ...base, id: 'a-2', kind: 'run.failed', v: 2 } as never,
                    raw: { secret: 'payload-2' },
                },
                {
                    kind: 'unknown',
                    base: { ...base, id: 'a-4', kind: 'constructor.started', v: 1, agentName: null } as never,
                    raw: {},
                },
                {
                    kind: 'invalid',
                    base: { ...base, id: 'a-3', kind: 'member.joined', v: 1 } as never,
                    issues: [{ path: 'displayName', code: 'invalid_type' }],
                },
            ]),
        );
        renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();

        const cards = await within(region).findAllByRole('listitem');
        expect(cards.map((card) => card.querySelector('code')?.textContent)).toEqual([
            'deploy.started',
            'run.failed',
            'constructor.started',
            'member.joined',
        ]);
        for (const card of cards) {
            expect(card.textContent).toMatch(/Ada|Unnamed agent/);
            expect(card.textContent).not.toContain('payload');
        }
        expect(cards[2]?.textContent).toContain('Unnamed agent');
    });

    it('renders a hostile agent name as text, linking by the agent ID', async () => {
        const engine = createHomeEngine();
        engine.spies.activity.mockImplementation(() =>
            page([
                {
                    kind: 'unknown',
                    base: { ...base, agentName: HOSTILE, kind: 'deploy.started', v: 1 } as never,
                    raw: {},
                },
                {
                    kind: 'known',
                    activity: {
                        ...base,
                        id: 'a-2',
                        agentName: HOSTILE,
                        kind: 'run.started',
                        v: 1,
                        runId: 'run-completed',
                        source: 'web',
                    } as never,
                },
            ]),
        );
        renderWithProviders({ path: '/', engineApi: engine.client });
        const region = await feed();

        const links = await within(region).findAllByRole('link', { name: HOSTILE });
        expect(links).toHaveLength(2);
        for (const link of links) expect(link.getAttribute('href')).toBe('/agents/agent-ada');
        expect(region.querySelector('img, script')).toBeNull();
        expect(window.__ptbkCspViolations).toEqual([]);
    });

    it('announces the raw kind when a renderer cannot summarise its item', async () => {
        const broken = defineFeature({
            id: 'broken-summary',
            requires: {},
            activityRenderers: [
                {
                    kind: 'member.joined',
                    versions: [1],
                    component: () => null,
                    summary: () => {
                        throw new Error('summary bug');
                    },
                },
            ],
        });
        const engine = createHomeEngine();
        renderWithProviders({ path: '/', engineApi: engine.client, features: [broken, ...FEATURES] });
        await within(await feed()).findAllByRole('listitem');

        act(() => {
            engine.controller.appendActivity(memberJoined(1));
        });
        await waitFor(() => {
            expect(liveRegion()?.textContent).toBe('member.joined');
        });
    });

    it('keeps a feed alive when a renderer throws, showing that item’s generic card', async () => {
        const broken = defineFeature({
            id: 'broken',
            requires: {},
            activityRenderers: [
                {
                    kind: 'member.joined',
                    versions: [1],
                    component: () => {
                        throw new Error('renderer bug');
                    },
                    summary: () => 'never',
                },
            ],
        });
        const engine = createHomeEngine({ activity: seededActivity(5) });
        renderWithProviders({ path: '/', engineApi: engine.client, features: [...FEATURES, broken] });
        const region = await feed();

        await waitFor(() => {
            expect(within(region).getAllByRole('listitem')).toHaveLength(5);
        });
        expect(within(region).getByText('member.joined')).toBeDefined();
    });
});
