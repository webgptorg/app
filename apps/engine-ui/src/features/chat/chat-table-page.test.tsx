import { createProblem } from '@ptbk/engine-api';
import type { InMemorySeedChat } from '@ptbk/engine-api/in-memory';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { OWNER_ID, SECOND_MEMBER_ID, SECOND_MEMBER_NAME } from '../../testing/agents-engine';
import { CHAT_AGENT_ID, controlReplyStreams, createChatEngine, seededConversation } from '../../testing/chat-engine';
import type { ChatEngine, ChatEngineOptions, SeedMessage } from '../../testing/chat-engine';
import { renderWithProviders } from '../../testing/render-with-providers';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

const LIST_PATH = `/agents/${CHAT_AGENT_ID}/chat`;
const table = () => screen.getByRole('table', { name: 'Chats with Ada' });
const chatLinks = () =>
    within(table())
        .queryAllByRole('link')
        .map((link) => link.textContent);

/** Three chats: the owner's (titled), another member's (untitled, so its first message names it), a visitor's. */
function mixedChats(): Pick<ChatEngineOptions, 'chats' | 'messages'> {
    const own = seededConversation('chat-own', 2, OWNER_ID);
    const jana = seededConversation('chat-jana', 4, SECOND_MEMBER_ID);
    const visitor = seededConversation('chat-visitor', 2, null);
    const janaMessages = jana.messages.map((message, index) =>
        index === 0 ? { ...message, content: 'Can you check the invoice?' } : message,
    );
    const api: InMemorySeedChat = {
        ...seededConversation('chat-api', 0, null).chat,
        title: 'Nightly sync',
        source: 'api',
    };
    return {
        chats: [{ ...own.chat, title: 'Quarterly plan' }, jana.chat, visitor.chat, api],
        messages: [...own.messages, ...janaMessages, ...visitor.messages],
    };
}

/** `count` chats of the owner, newest first: `Chat 001` is the most recent. */
function manyChats(count: number): Pick<ChatEngineOptions, 'chats' | 'messages'> {
    const chats: InMemorySeedChat[] = [];
    const messages: SeedMessage[] = [];
    for (let index = 1; index <= count; index++) {
        const number = String(index).padStart(3, '0');
        const updatedAt = new Date(Date.parse('2026-10-01T00:00:00Z') - index * 60_000).toISOString();
        chats.push({
            id: `chat-${number}`,
            agentId: CHAT_AGENT_ID,
            title: `Chat ${number}`,
            createdBy: OWNER_ID,
            createdAt: updatedAt,
            updatedAt,
        });
    }
    return { chats, messages };
}

async function renderList(path = LIST_PATH, engine: ChatEngine = createChatEngine(mixedChats())) {
    const app = renderWithProviders({ path, engineApi: engine.client });
    await screen.findByRole('table', { name: 'Chats with Ada' });
    await waitFor(() => {
        expect(chatLinks().length).toBeGreaterThan(0);
    });
    return { ...app, engine };
}

describe('chat list', { timeout: TIMEOUT_MS }, () => {
    it('lists every chat of the agent with its source and who started it, including other members’ and visitors’', async () => {
        await renderList();
        expect(chatLinks()).toEqual(
            expect.arrayContaining(['Quarterly plan', 'Can you check the invoice?', 'Question 1', 'Nightly sync']),
        );
        const row = (name: string) => screen.getByRole('link', { name }).closest('tr') as HTMLElement;
        expect(within(row('Quarterly plan')).getByText('You')).toBeDefined();
        expect(within(row('Quarterly plan')).getByText('Web')).toBeDefined();
        expect(await within(row('Can you check the invoice?')).findByText(SECOND_MEMBER_NAME)).toBeDefined();
        expect(within(row('Can you check the invoice?')).getByText('4')).toBeDefined();
        expect(within(row('Question 1')).getByText('Visitor')).toBeDefined();
        expect(within(row('Nightly sync')).getByText('API')).toBeDefined();
        expect(within(row('Nightly sync')).queryByRole('time')).toBeNull();
        expect(screen.getByRole('link', { name: 'Quarterly plan' }).getAttribute('href')).toBe(`${LIST_PATH}/chat-own`);
    });

    it('writes the source filter to the URL, sends it to the engine and restores it on reload', async () => {
        const { user, router, engine } = await renderList();
        await user.selectOptions(screen.getByRole('combobox', { name: 'Source' }), 'api');
        await waitFor(() => {
            expect(router.state.location.search).toEqual({ source: 'api' });
        });
        expect(engine.spies.list).toHaveBeenLastCalledWith(CHAT_AGENT_ID, { source: 'api' }, expect.anything());
        await waitFor(() => {
            expect(chatLinks()).toEqual(['Nightly sync']);
        });

        const href = router.state.location.href;
        const reloaded = createChatEngine(mixedChats());
        renderWithProviders({ path: href, engineApi: reloaded.client });
        await waitFor(() => {
            expect(reloaded.spies.list).toHaveBeenCalledWith(CHAT_AGENT_ID, { source: 'api' }, expect.anything());
        });
        const selects = await screen.findAllByRole('combobox', { name: 'Source' });
        expect((selects.at(-1) as HTMLSelectElement).value).toBe('api');
    });

    it('pages with a cursor in the URL, and a reload shows the same page', async () => {
        const { user, router } = await renderList(LIST_PATH, createChatEngine(manyChats(60)));
        expect(chatLinks()[0]).toBe('Chat 001');
        await user.click(screen.getByRole('button', { name: 'Next page' }));
        await waitFor(() => {
            expect(chatLinks()[0]).toBe('Chat 051');
        });
        const { cursor } = router.state.location.search as { readonly cursor?: string };
        expect(cursor).toEqual(expect.any(String));

        const reloaded = createChatEngine(manyChats(60));
        renderWithProviders({ path: router.state.location.href, engineApi: reloaded.client });
        await waitFor(() => {
            expect(reloaded.spies.list).toHaveBeenCalledWith(CHAT_AGENT_ID, { cursor }, expect.anything());
        });
        await user.click(screen.getAllByRole('button', { name: 'Previous page' })[0] as HTMLElement);
        await waitFor(() => {
            expect(router.state.location.search).toEqual({});
        });
    });

    it('falls back to defaults for an unknown source or a garbage cursor, and restarts on an expired cursor', async () => {
        const { router, engine } = await renderList(`${LIST_PATH}?source=fax&cursor=%25%25`);
        expect(router.state.location.search).toEqual({});
        expect(engine.spies.list.mock.calls[0]?.[1]).toEqual({});

        const expired = createChatEngine(mixedChats());
        const app = renderWithProviders({ path: `${LIST_PATH}?cursor=WyJ4Il0`, engineApi: expired.client });
        await waitFor(() => {
            expect(app.router.state.location.search).toEqual({});
        });
    });

    it('shows the empty state, the no-results state and the error state with retry', async () => {
        const empty = createChatEngine();
        renderWithProviders({ path: LIST_PATH, engineApi: empty.client });
        expect(await screen.findByText('No chats yet')).toBeDefined();
        expect(screen.getByText('Conversations with Ada appear here.')).toBeDefined();

        const filtered = createChatEngine();
        const app = renderWithProviders({ path: `${LIST_PATH}?source=email`, engineApi: filtered.client });
        expect(await screen.findByText('No results match your filters')).toBeDefined();
        await app.user.selectOptions(screen.getAllByRole('combobox', { name: 'Source' }).at(-1) as HTMLElement, '');
        await waitFor(() => {
            expect(app.router.state.location.search).toEqual({});
        });

        const failing = createChatEngine(mixedChats());
        failing.spies.list.mockResolvedValue({ kind: 'problem', problem: createProblem('validation-failed') });
        const failed = renderWithProviders({ path: LIST_PATH, engineApi: failing.client });
        expect(await screen.findByText('Chats could not be loaded')).toBeDefined();
        failing.spies.list.mockRestore();
        await failed.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('link', { name: 'Quarterly plan' })).toBeDefined();
    });

    it('preloads a chat’s first message page when its link is hovered', async () => {
        const { engine } = await renderList();
        expect(engine.spies.listMessages).not.toHaveBeenCalled();
        fireEvent.mouseEnter(screen.getByRole('link', { name: 'Quarterly plan' }));
        await waitFor(() => {
            expect(engine.spies.listMessages).toHaveBeenCalledWith('chat-own', { limit: 50 }, expect.anything());
        });
    });

    it('refetches the list when the engine reports a chat changed', async () => {
        const { engine } = await renderList();
        const calls = engine.spies.list.mock.calls.length;
        engine.controller.addVisitorChat({
            agentId: CHAT_AGENT_ID,
            messages: [{ role: 'user', content: 'Do you deliver on Sundays?' }],
        });
        expect(await screen.findByRole('link', { name: 'Do you deliver on Sundays?' })).toBeDefined();
        expect(engine.spies.list.mock.calls.length).toBeGreaterThan(calls);
    });

    it('has no axe violations', async () => {
        const { container } = await renderList();
        await expectNoAxeViolations(container);
    });
});

describe('new chat', { timeout: TIMEOUT_MS }, () => {
    it('starts a chat with the first message and opens it, following the reply', async () => {
        const engine = createChatEngine(mixedChats());
        const control = controlReplyStreams(engine);
        const { user, router } = await renderList(LIST_PATH, engine);
        await user.click(screen.getByRole('textbox', { name: 'New chat' }));
        await user.keyboard('Plan my week{Enter}');
        await waitFor(() => {
            expect(router.state.location.pathname).toMatch(new RegExp(`^${LIST_PATH}/chat-\\d+$`));
        });
        expect(engine.spies.create).toHaveBeenCalledWith(CHAT_AGENT_ID, {}, expect.anything());
        expect(await screen.findByRole('heading', { level: 2, name: 'Plan my week' })).toBeDefined();
        await waitFor(() => {
            expect(control.streams).toHaveLength(1);
        });
        expect(screen.getByText('Replying…')).toBeDefined();
    });

    it('keeps the text and says why when the chat cannot be started', async () => {
        const engine = createChatEngine(mixedChats());
        engine.spies.create.mockResolvedValueOnce({ kind: 'problem', problem: createProblem('agent-deleted') });
        engine.spies.sendMessage.mockRejectedValueOnce(new TypeError('offline'));
        const { user } = await renderList(LIST_PATH, engine);
        const box = screen.getByRole('textbox', { name: 'New chat' });
        await user.click(box);
        await user.keyboard('Hello{Enter}');
        expect(await screen.findByText('Your message was not sent')).toBeDefined();
        expect((box as HTMLTextAreaElement).value).toBe('Hello');
        await user.keyboard('{Enter}');
        await waitFor(() => {
            expect(screen.getAllByText('Your message was not sent')).toHaveLength(2);
        });
        expect((box as HTMLTextAreaElement).value).toBe('Hello');
    });

    it('is absent without chats.write', async () => {
        await renderList(LIST_PATH, createChatEngine({ ...mixedChats(), permissions: ['agents.read', 'chats.read'] }));
        expect(screen.queryByRole('textbox', { name: 'New chat' })).toBeNull();
    });

    it('is not available without chats.read', async () => {
        const engine = createChatEngine({ ...mixedChats(), permissions: ['agents.read'] });
        renderWithProviders({ path: LIST_PATH, engineApi: engine.client });
        expect(await screen.findByRole('heading', { level: 1, name: 'No access' })).toBeDefined();
        expect(screen.queryByRole('tab', { name: 'Chat' })).toBeNull();
    });
});
