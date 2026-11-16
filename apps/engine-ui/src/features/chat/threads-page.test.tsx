import { createProblem } from '@ptbk/engine-api';
import type { Permission } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { OWNER_ID } from '../../testing/agents-engine';
import { CHAT_AGENT_ID, CHATTER_ID, createChatEngine, seededConversation } from '../../testing/chat-engine';
import { renderWithProviders } from '../../testing/render-with-providers';

const TIMEOUT_MS = 20_000;
const ADA = { kind: 'agent', key: CHAT_AGENT_ID } as const;
const CHATTER = { kind: 'agent', key: CHATTER_ID } as const;

function threads(permissions?: readonly Permission[]) {
    return createChatEngine({
        ...(permissions === undefined ? {} : { permissions }),
        chats: [
            seededConversation('chat-own', 2, OWNER_ID),
            {
                id: 'Report',
                title: 'Report',
                createdAt: '2026-10-01T08:00:00.000Z',
                entries: [{ type: 'message', author: CHATTER, content: 'All quiet.' }],
            },
            {
                id: 'chat-question',
                title: 'Shipping',
                createdAt: '2026-10-01T09:00:00.000Z',
                entries: [
                    { type: 'joined', participant: CHATTER },
                    { type: 'joined', participant: ADA },
                    { type: 'message', author: ADA, content: '+@User Do we ship to Brno?' },
                ],
            },
        ],
    });
}

describe('threads page', { timeout: TIMEOUT_MS }, () => {
    it('lists threads as rich rows: who is in them, their newest words, what needs you apart from unread', async () => {
        const engine = threads();
        renderWithProviders({ path: '/chats', engineApi: engine.client });
        const table = await screen.findByRole('table', { name: 'Chats' });
        const row = (name: string) =>
            within(table)
                .getAllByRole('row')
                .find((item) => within(item).queryByRole('link', { name }) !== null) as HTMLElement;
        expect(within(row('Shipping')).getByText('Needs you')).toBeDefined();
        expect(within(row('Shipping')).getByText('Chatter, Ada')).toBeDefined();
        expect(within(row('Shipping')).getByText('Do we ship to Brno?', { exact: false })).toBeDefined();
        expect(within(row('Report')).getByText('1 new')).toBeDefined();
        expect(within(row('Report')).getByText('All quiet.')).toBeDefined();
        expect(within(row('Chat with Ada')).queryByText(/new|Needs you/)).toBeNull();
        expect(within(table).getByRole('link', { name: 'Shipping' }).getAttribute('href')).toBe('/chats/chat-question');
        await expectNoAxeViolations(document.body);
    });

    it('searches titles on the engine and keeps the search, agent and needs-you filters in the URL', async () => {
        const engine = threads();
        const app = renderWithProviders({ path: '/chats?needs=you', engineApi: engine.client });
        const table = await screen.findByRole('table', { name: 'Chats' });
        expect(await within(table).findByRole('link', { name: 'Shipping' })).toBeDefined();
        expect(within(table).queryByRole('link', { name: 'Report' })).toBeNull();

        await app.user.type(screen.getByRole('searchbox', { name: 'Search chats' }), 'Rep');
        await waitFor(() => {
            expect(app.router.state.location.search).toMatchObject({ q: 'Rep', needs: 'you' });
        });
        await waitFor(() => {
            expect(engine.spies.listAll).toHaveBeenCalledWith(expect.objectContaining({ q: 'Rep' }), expect.anything());
        });
        expect(await screen.findByText('No chat matches')).toBeDefined();
        await app.user.click(screen.getAllByRole('button', { name: 'Clear filters' })[0] as HTMLElement);
        await waitFor(() => {
            expect(app.router.state.location.search).toEqual({});
        });
        expect(await within(table).findByRole('link', { name: 'Report' })).toBeDefined();
    });

    it("narrows to one agent's threads, with a search, by membership", async () => {
        const engine = threads();
        renderWithProviders({ path: `/chats?agentId=${CHAT_AGENT_ID}&q=Ship`, engineApi: engine.client });
        const table = await screen.findByRole('table', { name: 'Chats' });
        expect(await within(table).findByRole('link', { name: 'Shipping' })).toBeDefined();
        expect(within(table).queryByRole('link', { name: 'Report' })).toBeNull();
        expect(engine.spies.listAll).toHaveBeenCalledWith(expect.objectContaining({ q: 'Ship' }), expect.anything());
    });

    it('never asks for agents without agents.read: no agent filter, faces by their hue, chips without links', async () => {
        const engine = threads(['chats.read', 'chats.write', 'members.read']);
        const agentList = vi.spyOn(engine.client.agents, 'list');
        const app = renderWithProviders({ path: '/chats', engineApi: engine.client });
        await screen.findByRole('table', { name: 'Chats' });
        await app.user.click(screen.getByRole('button', { name: 'Filter' }));
        expect(await screen.findByRole('option', { name: 'Attention' })).toBeDefined();
        expect(screen.queryByRole('option', { name: 'Agent' })).toBeNull();
        expect(agentList).not.toHaveBeenCalled();
    });

    it('opens a new thread with Chatter by default, and with another agent from the menu', async () => {
        const engine = threads();
        const app = renderWithProviders({ path: '/chats', engineApi: engine.client });
        await app.user.click(await screen.findByRole('button', { name: 'New chat' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Chat with Chatter' })).toBeDefined();
        const first = engine.spies.create.mock.calls[0]?.[0];
        expect(Object.keys(first ?? {})).toEqual(['requestKey']);

        const trail = await screen.findByRole('navigation', { name: 'Breadcrumb' });
        await app.user.click(within(trail).getByRole('link', { name: 'Chats' }));
        await app.user.click(await screen.findByRole('button', { name: 'Start with another agent' }));
        await app.user.click(await screen.findByRole('menuitem', { name: 'Ada' }));
        await waitFor(() => {
            expect(engine.spies.create.mock.calls[1]?.[0]).toMatchObject({ agentId: CHAT_AGENT_ID });
        });
        expect(await screen.findByRole('heading', { level: 1, name: 'Chat with Ada' })).toBeDefined();
    });

    it("lists an agent's threads on its Chat tab", async () => {
        const engine = threads();
        renderWithProviders({ path: `/agents/${CHAT_AGENT_ID}/chat`, engineApi: engine.client });
        const table = await screen.findByRole('table', { name: 'Chats' });
        const threadLinks = (await within(table).findAllByRole('link')).filter(
            (link) => link.getAttribute('href')?.startsWith('/chats/') === true,
        );
        expect(threadLinks).toHaveLength(2);
        expect(screen.getByRole('button', { name: 'New chat with Ada' })).toBeDefined();
    });

    it('says why a start was refused, and retries a start that may have happened under the same key', async () => {
        const engine = threads();
        engine.spies.create
            .mockResolvedValueOnce({ kind: 'problem', problem: createProblem('chatter-missing') })
            .mockResolvedValueOnce({ kind: 'problem', problem: createProblem('forbidden') })
            .mockResolvedValueOnce({ kind: 'problem', problem: createProblem('internal-error') })
            .mockRejectedValueOnce(new TypeError('offline'));
        const app = renderWithProviders({ path: '/chats', engineApi: engine.client });
        const start = await screen.findByRole('button', { name: 'New chat' });
        await app.user.click(start);
        expect(await screen.findByText(/Chatter isn’t set up on this engine yet/)).toBeDefined();
        await app.user.click(start);
        expect(await screen.findByText('Not allowed')).toBeDefined();
        await app.user.click(start);
        expect(await screen.findByText('The chat didn’t start. Try again.')).toBeDefined();
        await app.user.click(start);
        await waitFor(() => {
            expect(engine.spies.create).toHaveBeenCalledTimes(4);
        });
        await app.user.click(start);
        expect(await screen.findByRole('heading', { level: 1, name: 'Chat with Chatter' })).toBeDefined();
        const keys = engine.spies.create.mock.calls.map(([body]) => body.requestKey);
        expect(keys[4]).toBe(keys[2]);
        expect(keys[3]).toBe(keys[2]);
        expect(keys[2]).not.toBe(keys[1]);
    });

    it('shows an empty list and a list that failed to load, with retry', async () => {
        const engine = createChatEngine();
        engine.spies.listAll.mockResolvedValue({ kind: 'problem', problem: createProblem('validation-failed') });
        const app = renderWithProviders({ path: '/chats', engineApi: engine.client });
        const retry = await screen.findByRole('button', { name: 'Try again' });
        engine.spies.listAll.mockRestore();
        await app.user.click(retry);
        expect(await screen.findByText('No chats yet')).toBeDefined();
    });

    it('starts a thread with the agent from its Chat tab, which a member who may only read cannot', async () => {
        const engine = threads();
        const app = renderWithProviders({ path: `/agents/${CHAT_AGENT_ID}/chat`, engineApi: engine.client });
        await app.user.click(await screen.findByRole('button', { name: 'New chat with Ada' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Chat with Ada' })).toBeDefined();
        expect(engine.spies.create.mock.calls[0]?.[0]).toMatchObject({ agentId: CHAT_AGENT_ID });

        const reader = createChatEngine({ permissions: ['agents.read', 'chats.read', 'members.read'] });
        renderWithProviders({ path: `/agents/${CHAT_AGENT_ID}/chat`, engineApi: reader.client });
        expect(await screen.findByText('No chats yet')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'New chat with Ada' })).toBeNull();
    });
});
