import { ChatId, createProblem, MessageId, Timestamp } from '@ptbk/engine-api';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { OWNER_ID } from '../../testing/agents-engine';
import { completedReply, controlReplyStreams, createChatEngine, seededConversation } from '../../testing/chat-engine';
import type { ChatEngine } from '../../testing/chat-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { ESTIMATED_ROW_PX } from './message-list';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 30_000;
const CHAT_ID = 'chat-own';

const composer = () => screen.getByRole('textbox', { name: 'Message' });
const history = () => screen.getByRole('region', { name: 'Messages' });
const replyStop = () =>
    screen.queryAllByRole('button', { name: 'Stop' }).find((button) => button.closest('form') !== null) ?? null;

function ownChatEngine(count = 2) {
    const engine = createChatEngine({ chats: [seededConversation(CHAT_ID, count, OWNER_ID)] });
    return { engine, control: controlReplyStreams(engine) };
}

async function renderThread(engine: ChatEngine, chatId = CHAT_ID) {
    const app = renderWithProviders({ path: `/chats/${chatId}`, engineApi: engine.client });
    await screen.findByRole('region', { name: 'Messages' });
    return app;
}

/** Sends from the composer and waits for the panel to follow the reply; answers the reply's ID. */
async function sendAndFollow(app: Awaited<ReturnType<typeof renderThread>>, engine: ChatEngine, text: string) {
    const streams = engine.spies.streamReply.mock.calls.length;
    await app.user.click(composer());
    await app.user.keyboard(text);
    await app.user.keyboard('{Enter}');
    await waitFor(() => {
        expect(engine.spies.streamReply.mock.calls.length).toBe(streams + 1);
    });
    const replyId = engine.spies.streamReply.mock.calls.at(-1)?.[1];
    if (replyId === undefined) throw new Error('no reply followed');
    return replyId;
}

const done = (replyId: string, content: string) =>
    completedReply(
        {
            id: MessageId.parse(replyId),
            chatId: ChatId.parse(CHAT_ID),
            createdAt: Timestamp.parse('2026-10-01T00:00:00.000Z'),
        },
        content,
    );

describe('thread stop', { timeout: TIMEOUT_MS }, () => {
    it('stops with Esc from the composer', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderThread(engine);
        await sendAndFollow(app, engine, 'Hi');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Partial' });
        });
        await within(history()).findByText('Partial');
        composer().focus();
        await app.user.keyboard('{Escape}');
        expect(await within(history()).findByText('Stopped')).toBeDefined();
        expect(engine.spies.cancelReply).toHaveBeenCalledTimes(1);
    });

    it('settles a reply that finished before the cancel arrived', async () => {
        const { engine, control } = ownChatEngine();
        engine.spies.cancelReply.mockResolvedValue({ kind: 'problem', problem: createProblem('reply-finished') });
        const app = await renderThread(engine);
        await sendAndFollow(app, engine, 'Hi');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Almost done' });
        });
        await within(history()).findByText('Almost done');
        const stop = replyStop();
        if (stop === null) throw new Error('no Stop');
        await app.user.click(stop);
        await waitFor(() => {
            expect(replyStop()).toBeNull();
        });
    });

    it('reports a failed cancel and offers to resume', async () => {
        const { engine, control } = ownChatEngine();
        engine.spies.cancelReply.mockRejectedValue(new TypeError('offline'));
        const app = await renderThread(engine);
        await sendAndFollow(app, engine, 'Hi');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Going' });
        });
        await within(history()).findByText('Going');
        const stop = replyStop();
        if (stop === null) throw new Error('no Stop');
        await app.user.click(stop);
        expect(await screen.findByText('That did not work. Please try again.')).toBeDefined();
        expect(within(history()).getByText('Connection lost')).toBeDefined();
    });
});

describe('thread interruptions', { timeout: TIMEOUT_MS }, () => {
    it('marks a dropped stream interrupted and resumes after the last delta only on Retry', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderThread(engine);
        const replyId = await sendAndFollow(app, engine, 'Tell me');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'First part' });
            control.latest().end();
        });
        expect(await within(history()).findByText('Connection lost')).toBeDefined();
        expect(engine.spies.streamReply).toHaveBeenCalledTimes(1);

        await app.user.click(within(history()).getByRole('button', { name: 'Try again' }));
        await waitFor(() => {
            expect(engine.spies.streamReply).toHaveBeenCalledTimes(2);
        });
        expect(control.streams[1]?.lastEventId).toBe('1');
        act(() => {
            control.latest().push({ type: 'delta', seq: 2, text: ', second part' });
            control.latest().push({ type: 'completed', message: done(replyId, 'First part, second part') });
        });
        expect(await within(history()).findByText('First part, second part')).toBeDefined();
        expect(within(history()).queryByText('Connection lost')).toBeNull();
    });

    it.each([
        ['refused', { kind: 'problem', problem: createProblem('internal-error') }],
        ['broken', new TypeError('offline')],
    ] as const)('treats a %s stream as dropped', async (_, outcome) => {
        const { engine } = ownChatEngine();
        if (outcome instanceof Error) engine.spies.streamReply.mockRejectedValue(outcome);
        else engine.spies.streamReply.mockResolvedValue(outcome);
        const app = await renderThread(engine);
        await app.user.click(composer());
        await app.user.keyboard('Hi{Enter}');
        expect(await within(history()).findByText('Connection lost')).toBeDefined();
    });

    it('shows a failed reply and sends the message again, under a new key, only on Retry', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderThread(engine);
        await sendAndFollow(app, engine, 'Summarise');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Half' });
            control.latest().push({ type: 'failed', problem: createProblem('reply-failed') });
        });
        expect(await within(history()).findByText('The reply failed')).toBeDefined();
        expect(engine.spies.sendMessage).toHaveBeenCalledTimes(1);

        await app.user.click(within(history()).getByRole('button', { name: 'Try again' }));
        await waitFor(() => {
            expect(engine.spies.sendMessage).toHaveBeenCalledTimes(2);
        });
        const [first, second] = engine.spies.sendMessage.mock.calls.map(([, body]) => body);
        expect(second?.content).toBe('Summarise');
        expect(second?.requestKey).not.toBe(first?.requestKey);
    });

    it('settles an interrupted reply the refetch shows finished', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderThread(engine);
        const replyId = await sendAndFollow(app, engine, 'Hi');
        await engine.real.cancelReply(ChatId.parse(CHAT_ID), MessageId.parse(replyId), AbortSignal.timeout(1000));
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Kept' });
            control.latest().end();
        });
        expect(await within(history()).findByText('Stopped')).toBeDefined();
        expect(within(history()).queryByText('Connection lost')).toBeNull();
    });
});

describe('thread sending', { timeout: TIMEOUT_MS }, () => {
    it('removes a message the engine refused, gives the text back and says why', async () => {
        const { engine } = ownChatEngine();
        engine.spies.sendMessage.mockResolvedValueOnce({
            kind: 'problem',
            problem: createProblem('validation-failed'),
        });
        const app = await renderThread(engine);
        await app.user.click(composer());
        await app.user.keyboard('Are you there?{Enter}');
        expect(await screen.findByText('Your message was not sent')).toBeDefined();
        expect(within(history()).queryByText('Are you there?')).toBeNull();
        expect((composer() as HTMLTextAreaElement).value).toBe('Are you there?');
    });

    it('says "not allowed" for a 403 and that the session ended for a 401, keeping the text', async () => {
        const { engine } = ownChatEngine();
        engine.spies.sendMessage
            .mockResolvedValueOnce({ kind: 'problem', problem: createProblem('forbidden') })
            .mockResolvedValueOnce({ kind: 'problem', problem: createProblem('unauthenticated') });
        const app = await renderThread(engine);
        await app.user.click(composer());
        await app.user.keyboard('One{Enter}');
        expect(await screen.findByText('Not allowed')).toBeDefined();
        await app.user.keyboard('{Enter}');
        expect(await screen.findByText(/You’re signed out, so this wasn’t sent/)).toBeDefined();
        expect((composer() as HTMLTextAreaElement).value).toBe('One');
    });

    it('sends again under the same key after a 5xx, which may come after the engine kept the message', async () => {
        const { engine } = ownChatEngine();
        engine.spies.sendMessage.mockResolvedValueOnce({ kind: 'problem', problem: createProblem('internal-error') });
        const app = await renderThread(engine);
        await app.user.click(composer());
        await app.user.keyboard('Maybe{Enter}');
        expect(await within(history()).findByText('Couldn’t check whether this arrived')).toBeDefined();
        await app.user.click(within(history()).getByRole('button', { name: 'Check again' }));
        await waitFor(() => {
            expect(engine.spies.sendMessage).toHaveBeenCalledTimes(2);
        });
        expect(await within(history()).findByText('Maybe')).toBeDefined();
    });
});

describe('thread states', { timeout: TIMEOUT_MS }, () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('shows an empty thread and one that failed to load, with retry', async () => {
        const engine = createChatEngine({
            chats: [{ id: 'chat-empty', title: 'Fresh', createdAt: '2026-10-01T00:00:00.000Z', entries: [] }],
        });
        engine.spies.listEntries.mockResolvedValue({ kind: 'problem', problem: createProblem('validation-failed') });
        const app = renderWithProviders({ path: '/chats/chat-empty', engineApi: engine.client });
        expect(await screen.findByText('Messages could not be loaded')).toBeDefined();
        engine.spies.listEntries.mockRestore();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('No messages yet.')).toBeDefined();
    });

    it('says "chat not found" for an unknown thread and a malformed ID', async () => {
        const { engine } = ownChatEngine();
        renderWithProviders({ path: '/chats/chat-missing', engineApi: engine.client });
        expect(await screen.findByRole('heading', { name: 'Chat not found' })).toBeDefined();
        renderWithProviders({ path: '/chats/bad%0Aid', engineApi: engine.client });
        await waitFor(() => {
            expect(screen.getAllByRole('heading', { name: 'Chat not found' })).toHaveLength(2);
        });
    });

    it('fetches the newest page when the engine reports an entry the panel does not have', async () => {
        const { engine } = ownChatEngine();
        await renderThread(engine);
        await engine.real.sendMessage(ChatId.parse(CHAT_ID), { content: 'From elsewhere' }, AbortSignal.timeout(1000));
        expect(await within(history()).findByText('From elsewhere')).toBeDefined();
        expect(engine.spies.listEntries.mock.calls.at(-1)?.[1]).toEqual({ limit: 50 });
    });

    it('mounts only the visible window of a long thread, keeps its place as older pages load, and jumps to the latest', async () => {
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
        const engine = createChatEngine({ chats: [seededConversation('chat-long', 2000, OWNER_ID)] });
        const app = await renderThread(engine, 'chat-long');
        const region = history();
        const rows = () => region.querySelectorAll('article');
        fireEvent.scroll(region);
        expect(await within(region).findByText('Answer 2000')).toBeDefined();
        expect(rows().length).toBeGreaterThan(0);
        expect(rows().length).toBeLessThan(40);

        region.scrollTop = 0;
        fireEvent.scroll(region);
        await waitFor(() => {
            expect(engine.spies.listEntries).toHaveBeenCalledTimes(2);
        });
        expect(typeof engine.spies.listEntries.mock.calls[1]?.[1].cursor).toBe('string');
        await waitFor(() => {
            expect(region.scrollTop).toBe(50 * ESTIMATED_ROW_PX);
        });

        const jump = screen.getByRole('button', { name: 'Jump to latest' });
        jump.focus();
        await app.user.keyboard('{Enter}');
        fireEvent.scroll(region);
        expect(await within(region).findByText('Answer 2000')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
        expect(document.activeElement).toBe(composer());
        await expectNoAxeViolations(region);
    });

    it('mounts every message of a shorter thread and loads older ones from the button', async () => {
        const engine = createChatEngine({ chats: [seededConversation('chat-medium', 120, OWNER_ID)] });
        const app = await renderThread(engine, 'chat-medium');
        await waitFor(() => {
            expect(history().querySelectorAll('article')).toHaveLength(50);
        });
        await app.user.click(within(history()).getByRole('button', { name: 'Show more' }));
        await waitFor(() => {
            expect(history().querySelectorAll('article')).toHaveLength(100);
        });
    });
});
