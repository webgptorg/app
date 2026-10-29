import { createProblem } from '@ptbk/engine-api';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { OWNER_ID } from '../../testing/agents-engine';
import { CHAT_AGENT_ID, controlReplyStreams, createChatEngine, seededConversation } from '../../testing/chat-engine';
import type { ChatEngine } from '../../testing/chat-engine';
import { renderWithProviders } from '../../testing/render-with-providers';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

const CHAT_PATH = `/agents/${CHAT_AGENT_ID}/chat`;
const starter = () => screen.getByRole('textbox', { name: 'New chat' });

function engineWithAChat(options: { readonly agentSource?: string } = {}): ChatEngine {
    const own = seededConversation('chat-own', 2, OWNER_ID);
    return createChatEngine({ chats: [{ ...own.chat, title: 'Quarterly plan' }], messages: own.messages, ...options });
}

async function renderFresh(engine: ChatEngine = engineWithAChat()) {
    const app = renderWithProviders({ path: CHAT_PATH, engineApi: engine.client });
    await screen.findByRole('textbox', { name: 'New chat' });
    return { ...app, engine };
}

describe('fresh conversation', { timeout: TIMEOUT_MS }, () => {
    it('opens the Chat tab on an empty conversation with the agent and the message box, without the table', async () => {
        await renderFresh();
        expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('heading', { level: 2, name: 'Ada' })).toBeDefined();
        expect(screen.getByText('What can Ada help you with?')).toBeDefined();
        expect(starter().getAttribute('placeholder')).toBe('Message Ada…');
        expect(screen.queryByRole('table')).toBeNull();
        // Fills the screen like a chat, so the box is in view on a phone.
        const frame = screen.getAllByRole('heading', { level: 1 })[0]?.closest('section');
        expect(frame?.className).toContain('h-(--main-fill-height)');
    });

    it('greets with the book’s initial message, as text only', async () => {
        const agentSource = 'Ada\nINITIAL MESSAGE Hi! <b>Ask</b> me **anything** [here](javascript:alert(1))';
        await renderFresh(engineWithAChat({ agentSource }));
        const greeting = screen.getByText('Hi! <b>Ask</b> me **anything** [here](javascript:alert(1))');
        expect(greeting.children).toHaveLength(0);
        expect(screen.queryByText('What can Ada help you with?')).toBeNull();
    });

    it('falls back to the default greeting when the initial message is blank', async () => {
        await renderFresh(engineWithAChat({ agentSource: 'Ada\nINITIAL MESSAGE   ' }));
        expect(screen.getByText('What can Ada help you with?')).toBeDefined();
    });

    it('starts a chat with the first message and opens it, following the reply', async () => {
        const engine = engineWithAChat();
        const control = controlReplyStreams(engine);
        const { user, router } = await renderFresh(engine);
        await user.click(starter());
        await user.keyboard('Plan my week{Enter}');
        await waitFor(() => {
            expect(router.state.location.pathname).toMatch(new RegExp(`^${CHAT_PATH}/chat-\\d+$`));
        });
        expect(engine.spies.create).toHaveBeenCalledWith(CHAT_AGENT_ID, {}, expect.anything());
        expect(engine.spies.sendMessage).toHaveBeenCalledWith(
            expect.any(String),
            { content: 'Plan my week' },
            expect.anything(),
        );
        expect(await screen.findByRole('heading', { level: 2, name: 'Plan my week' })).toBeDefined();
        await waitFor(() => {
            expect(control.streams).toHaveLength(1);
        });
        expect(screen.getByText('Replying…')).toBeDefined();
        // The recent list picks the new chat up and marks it as the open one.
        const recent = screen.getByRole('navigation', { name: 'Recent chats' });
        await waitFor(() => {
            expect(recent.querySelector('[aria-current="page"]')?.textContent).toContain('Plan my week');
        });
    });

    it('keeps the text and says why when the chat cannot be started', async () => {
        const engine = engineWithAChat();
        engine.spies.create.mockResolvedValueOnce({ kind: 'problem', problem: createProblem('agent-deleted') });
        engine.spies.sendMessage.mockRejectedValueOnce(new TypeError('offline'));
        const { user } = await renderFresh(engine);
        const box = starter();
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

    it('has no axe violations', async () => {
        const { container } = await renderFresh();
        await screen.findByRole('link', { name: /Quarterly plan/ });
        await expectNoAxeViolations(container);
    });
});
