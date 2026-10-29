import { createProblem } from '@ptbk/engine-api';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OWNER_ID, SECOND_MEMBER_ID } from '../../testing/agents-engine';
import { CHAT_AGENT_ID, createChatEngine, seededConversation } from '../../testing/chat-engine';
import type { ChatEngine, ChatEngineOptions } from '../../testing/chat-engine';
import { renderWithProviders } from '../../testing/render-with-providers';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

const CHAT_PATH = `/agents/${CHAT_AGENT_ID}/chat`;

/** The owner's "Quarterly plan" (newest) and Jana's chat, named by its first message. */
function twoChats(options: Pick<ChatEngineOptions, 'permissions'> = {}): ChatEngine {
    const own = seededConversation('chat-own', 2, OWNER_ID);
    const jana = seededConversation('chat-jana', 4, SECOND_MEMBER_ID);
    return createChatEngine({
        chats: [{ ...own.chat, title: 'Quarterly plan' }, jana.chat],
        messages: [...own.messages, ...jana.messages],
        ...options,
    });
}

/** The column beside the chat; the drawer's copy exists only while it is open. */
const column = () => screen.getAllByRole('navigation', { name: 'Recent chats' })[0] as HTMLElement;

async function renderChat(engine: ChatEngine, chatId = 'chat-own') {
    const app = renderWithProviders({ path: `${CHAT_PATH}/${chatId}`, engineApi: engine.client });
    await screen.findByRole('heading', { level: 2, name: chatId === 'chat-own' ? 'Quarterly plan' : 'Question 1' });
    await within(column()).findByRole('link', { name: /Quarterly plan/ });
    return app;
}

describe('recent chats', { timeout: TIMEOUT_MS }, () => {
    it('lists the latest chats beside the open one, marks it, and links to a new chat and to all chats', async () => {
        await renderChat(twoChats());
        const recent = within(column());
        const links = recent.getAllByRole('link');
        expect(links.map((link) => link.getAttribute('href'))).toEqual([
            CHAT_PATH,
            `${CHAT_PATH}/chat-own`,
            `${CHAT_PATH}/chat-jana`,
            `${CHAT_PATH}/all`,
        ]);
        expect(links.map((link) => link.textContent)).toEqual([
            'New chat',
            expect.stringContaining('Quarterly plan'),
            expect.stringContaining('Question 1'),
            'All chats',
        ]);
        expect(recent.getByRole('link', { name: /Quarterly plan/ }).getAttribute('aria-current')).toBe('page');
        expect(recent.getByRole('link', { name: /Question 1/ }).getAttribute('aria-current')).toBeNull();
        expect(recent.getByRole('link', { name: 'New chat' }).getAttribute('aria-current')).toBeNull();
        expect(column().querySelectorAll('time')).toHaveLength(2);
    });

    it('marks "New chat" on the fresh conversation', async () => {
        renderWithProviders({ path: CHAT_PATH, engineApi: twoChats().client });
        const newChat = await within(await screen.findByRole('navigation', { name: 'Recent chats' })).findByRole(
            'link',
            { name: 'New chat' },
        );
        expect(newChat.getAttribute('aria-current')).toBe('page');
    });

    it('is navigation for members who may only read, without "New chat"', async () => {
        await renderChat(twoChats({ permissions: ['agents.read', 'chats.read'] }));
        const recent = within(column());
        expect(recent.queryByRole('link', { name: 'New chat' })).toBeNull();
        expect(recent.getByRole('link', { name: 'All chats' })).toBeDefined();
    });

    it('opens another chat from the list', async () => {
        const { user, router } = await renderChat(twoChats());
        await user.click(within(column()).getByRole('link', { name: /Question 1/ }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe(`${CHAT_PATH}/chat-jana`);
        });
        await waitFor(() => {
            expect(
                within(column())
                    .getByRole('link', { name: /Question 1/ })
                    .getAttribute('aria-current'),
            ).toBe('page');
        });
    });

    it('says when the list could not be loaded and retries', async () => {
        const engine = twoChats();
        engine.spies.list.mockResolvedValue({ kind: 'problem', problem: createProblem('validation-failed') });
        const { user } = renderWithProviders({ path: `${CHAT_PATH}/chat-own`, engineApi: engine.client });
        const recent = await screen.findByRole('navigation', { name: 'Recent chats' });
        expect(await within(recent).findByText('Chats could not be loaded')).toBeDefined();
        engine.spies.list.mockRestore();
        await user.click(within(recent).getByRole('button', { name: 'Try again' }));
        expect(await within(recent).findByRole('link', { name: /Quarterly plan/ })).toBeDefined();
    });

    it('says when the agent has no chats yet', async () => {
        renderWithProviders({ path: CHAT_PATH, engineApi: createChatEngine().client });
        const recent = await screen.findByRole('navigation', { name: 'Recent chats' });
        expect(await within(recent).findByText('No chats yet')).toBeDefined();
    });
});

describe('recent chats drawer', { timeout: TIMEOUT_MS }, () => {
    it('opens from the chat header where the list has no room, and closes when a chat is picked', async () => {
        const { user, router } = await renderChat(twoChats());
        // Small screens get the back link instead of the column.
        const back = screen.getAllByRole('link', { name: 'All chats' }).find((link) => link.closest('nav') === null);
        expect(back?.className).toContain('@2xl:hidden');
        const button = screen.getByRole('button', { name: 'Chats' });
        expect(button.getAttribute('aria-expanded')).toBe('false');
        await user.click(button);
        const drawer = await screen.findByRole('dialog', { name: 'Chats' });
        expect(button.getAttribute('aria-expanded')).toBe('true');
        const list = within(drawer).getByRole('navigation', { name: 'Recent chats' });
        await user.click(within(list).getByRole('link', { name: /Question 1/ }));
        await waitFor(() => {
            expect(router.state.location.pathname).toBe(`${CHAT_PATH}/chat-jana`);
        });
        await waitFor(() => {
            expect(screen.getAllByRole('navigation', { name: 'Recent chats' })).toHaveLength(1);
        });
    });

    it('opens from the fresh conversation too', async () => {
        const { user } = renderWithProviders({ path: CHAT_PATH, engineApi: twoChats().client });
        await user.click(await screen.findByRole('button', { name: 'Chats' }));
        const drawer = await screen.findByRole('dialog', { name: 'Chats' });
        expect(await within(drawer).findByRole('link', { name: /Quarterly plan/ })).toBeDefined();
    });
});
