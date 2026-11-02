import { createProblem } from '@ptbk/engine-api';
import type { SendMessageResult } from '@ptbk/engine-api';
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { expectNoAxeViolations } from '../../testing/axe';
import { OWNER_ID, SECOND_MEMBER_ID } from '../../testing/agents-engine';
import {
    CHAT_AGENT_ID,
    completedReply,
    controlReplyStreams,
    createChatEngine,
    seededConversation,
} from '../../testing/chat-engine';
import type { ChatEngine } from '../../testing/chat-engine';
import { renderWithProviders } from '../../testing/render-with-providers';
import { ESTIMATED_ROW_PX } from './message-list';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;
/** Longer than the pause before an unclear send is called lost. */
const SETTLE_WAIT = { timeout: 5_000 };

const CHAT_ID = 'chat-own';
const chatPath = (chatId = CHAT_ID) => `/agents/${CHAT_AGENT_ID}/chat/${chatId}`;

const announcer = () => document.querySelector<HTMLElement>('[aria-live="polite"][aria-atomic="true"]');
const composer = () => screen.getByRole('textbox', { name: 'Message' });
const history = () => screen.getByRole('region', { name: 'Messages' });
/** The composer's Stop, not the agent header's: with runs@1 the agent shows as working while it replies. */
const replyStop = () =>
    screen.queryAllByRole('button', { name: 'Stop' }).find((button) => button.closest('form') !== null) ?? null;
const getReplyStop = () => {
    const button = replyStop();
    if (button === null) throw new Error('no Stop button in the composer');
    return button;
};

function ownChatEngine(count = 2) {
    const own = seededConversation(CHAT_ID, count, OWNER_ID);
    const engine = createChatEngine({ chats: [own.chat], messages: own.messages });
    return { engine, control: controlReplyStreams(engine) };
}

async function renderChat(engine: ChatEngine, path = chatPath()) {
    const app = renderWithProviders({ path, engineApi: engine.client });
    await screen.findByRole('heading', { level: 2, name: 'Question 1' });
    return app;
}

type Sent = z.output<typeof SendMessageResult>;

async function lastSent(engine: ChatEngine): Promise<Sent> {
    const result = engine.spies.sendMessage.mock.results.at(-1)?.value as
        Promise<{ kind: 'ok'; data: Sent }> | undefined;
    if (result === undefined) throw new Error('nothing was sent');
    return (await result).data;
}

/** Sends `text` from the composer and waits for the panel to open the reply's stream. */
async function sendAndOpen(app: Awaited<ReturnType<typeof renderChat>>, engine: ChatEngine, text: string) {
    const streams = engine.spies.streamReply.mock.calls.length;
    await app.user.click(composer());
    await app.user.keyboard(text);
    await app.user.keyboard('{Enter}');
    await waitFor(() => {
        expect(engine.spies.streamReply.mock.calls.length).toBe(streams + 1);
    });
    return lastSent(engine);
}

describe('chat panel streaming', { timeout: TIMEOUT_MS }, () => {
    it('shows deltas in order as plain text, renders markdown only after completed, and announces once', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderChat(engine);
        const region = announcer();
        if (region === null) throw new Error('no live region');
        let announcements = 0;
        const observer = new MutationObserver(() => {
            announcements++;
        });
        observer.observe(region, { childList: true, characterData: true, subtree: true });

        const sent = await sendAndOpen(app, engine, 'Explain it');
        expect(within(history()).getByText('Explain it')).toBeDefined();
        const stream = control.latest();
        act(() => {
            stream.push({ type: 'delta', seq: 1, text: 'This is **bo' });
        });
        act(() => {
            stream.push({ type: 'delta', seq: 2, text: 'ld** news' });
        });
        expect(await within(history()).findByText('This is **bold** news')).toBeDefined();
        expect(within(history()).queryByText('bold', { selector: 'strong' })).toBeNull();
        expect(within(history()).getByText('Replying…')).toBeDefined();
        expect((composer() as HTMLTextAreaElement).readOnly).toBe(true);
        expect(region.textContent).toBe('');

        act(() => {
            stream.push({
                type: 'completed',
                message: completedReply(
                    { id: sent.replyMessageId, chatId: sent.userMessage.chatId, createdAt: sent.userMessage.createdAt },
                    'This is **bold** news',
                ),
            });
        });
        expect(await within(history()).findByText('bold', { selector: 'strong' })).toBeDefined();
        expect(within(history()).queryByText('Replying…')).toBeNull();
        await waitFor(() => {
            expect(region.textContent).toBe('Ada replied');
        });
        expect(announcements).toBe(1);
        expect((composer() as HTMLTextAreaElement).readOnly).toBe(false);
        observer.disconnect();
        // The engine's copy went into the cache: the history was not fetched again.
        expect(engine.spies.listMessages).toHaveBeenCalledTimes(1);
    });

    it('ignores deltas a resumed stream repeats, by seq', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderChat(engine);
        await sendAndOpen(app, engine, 'Go');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'one ' });
            control.latest().push({ type: 'delta', seq: 1, text: 'one ' });
            control.latest().push({ type: 'delta', seq: 2, text: 'two' });
        });
        expect(await within(history()).findByText('one two')).toBeDefined();
    });
});

describe('chat panel stop', { timeout: TIMEOUT_MS }, () => {
    it('aborts the stream, cancels once with the reply ID, keeps the partial text, and ignores a second stop', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderChat(engine);
        const sent = await sendAndOpen(app, engine, 'Write a long essay');
        const stream = control.latest();
        act(() => {
            stream.push({ type: 'delta', seq: 1, text: 'Once upon a time' });
        });
        await within(history()).findByText('Once upon a time');

        const stop = getReplyStop();
        await app.user.click(stop);
        await app.user.keyboard('{Escape}');
        expect(stream.aborted()).toBe(true);
        expect(await within(history()).findByText('Stopped')).toBeDefined();
        expect(within(history()).getByText('Once upon a time')).toBeDefined();
        expect(engine.spies.cancelReply).toHaveBeenCalledTimes(1);
        expect(engine.spies.cancelReply).toHaveBeenCalledWith(CHAT_ID, sent.replyMessageId, expect.anything());
        expect(replyStop()).toBeNull();
        expect(document.activeElement).toBe(composer());
    });

    it('stops with Esc from the composer', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderChat(engine);
        await sendAndOpen(app, engine, 'Hi');
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
        const app = await renderChat(engine);
        await sendAndOpen(app, engine, 'Hi');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Almost done' });
        });
        await within(history()).findByText('Almost done');
        await app.user.click(getReplyStop());
        await waitFor(() => {
            expect(replyStop()).toBeNull();
        });
        expect(engine.spies.listMessages.mock.calls.length).toBeGreaterThan(1);
    });

    it('reports a failed cancel and offers to resume', async () => {
        const { engine, control } = ownChatEngine();
        engine.spies.cancelReply.mockRejectedValue(new TypeError('offline'));
        const app = await renderChat(engine);
        await sendAndOpen(app, engine, 'Hi');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Going' });
        });
        await within(history()).findByText('Going');
        await app.user.click(getReplyStop());
        expect(await screen.findByText('That did not work. Please try again.')).toBeDefined();
        expect(within(history()).getByText('Connection lost')).toBeDefined();
    });
});

describe('chat panel interruptions', { timeout: TIMEOUT_MS }, () => {
    it('marks a dropped stream interrupted, refetches, and resumes after the last delta only on Retry', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderChat(engine);
        const sent = await sendAndOpen(app, engine, 'Tell me');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'First part' });
            control.latest().end();
        });
        expect(await within(history()).findByText('Connection lost')).toBeDefined();
        await waitFor(() => {
            expect(engine.spies.listMessages.mock.calls.length).toBe(2);
        });
        expect(engine.spies.streamReply).toHaveBeenCalledTimes(1);

        await app.user.click(within(history()).getByRole('button', { name: 'Try again' }));
        await waitFor(() => {
            expect(engine.spies.streamReply).toHaveBeenCalledTimes(2);
        });
        expect(control.streams[1]?.lastEventId).toBe('1');
        act(() => {
            control.latest().push({ type: 'delta', seq: 2, text: ', second part' });
            control.latest().push({
                type: 'completed',
                message: completedReply(
                    { id: sent.replyMessageId, chatId: sent.userMessage.chatId, createdAt: sent.userMessage.createdAt },
                    'First part, second part',
                ),
            });
        });
        expect(await within(history()).findByText('First part, second part')).toBeDefined();
        expect(within(history()).queryByText('Connection lost')).toBeNull();
    });

    it('treats a refused stream as dropped', async () => {
        const { engine } = ownChatEngine();
        engine.spies.streamReply.mockResolvedValue({ kind: 'problem', problem: createProblem('internal-error') });
        const app = await renderChat(engine);
        await sendAndOpen(app, engine, 'Hi');
        expect(await within(history()).findByText('Connection lost')).toBeDefined();
    });

    it('shows a failed reply and sends the message again only on Retry', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderChat(engine);
        await sendAndOpen(app, engine, 'Summarise');
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
        expect(engine.spies.sendMessage.mock.calls[1]?.[1]).toEqual({ content: 'Summarise' });
    });

    it('settles an interrupted reply the refetch shows finished', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderChat(engine);
        const sent = await sendAndOpen(app, engine, 'Hi');
        await engine.client.chats.cancelReply(sent.userMessage.chatId, sent.replyMessageId, AbortSignal.timeout(1000));
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Kept' });
            control.latest().end();
        });
        expect(await within(history()).findByText('Stopped')).toBeDefined();
        expect(within(history()).getByText('Kept')).toBeDefined();
        expect(within(history()).queryByText('Connection lost')).toBeNull();
    });
});

describe('chat panel sending', { timeout: TIMEOUT_MS }, () => {
    it('removes a message the engine refused, gives the text back and says why', async () => {
        const { engine } = ownChatEngine();
        let refuse: (() => void) | undefined;
        engine.spies.sendMessage.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    refuse = () => {
                        resolve({ kind: 'problem', problem: createProblem('agent-deleted') });
                    };
                }),
        );
        const app = await renderChat(engine);
        await app.user.click(composer());
        await app.user.keyboard('Are you there?{Enter}');
        expect(within(history()).getByText('Are you there?')).toBeDefined();
        expect((composer() as HTMLTextAreaElement).value).toBe('');
        act(() => {
            refuse?.();
        });
        expect(await screen.findByText('Your message was not sent')).toBeDefined();
        expect(within(history()).queryByText('Are you there?')).toBeNull();
        expect((composer() as HTMLTextAreaElement).value).toBe('Are you there?');
    });

    it('says "not allowed" when the engine refuses with 403, and handles a network failure', async () => {
        const { engine } = ownChatEngine();
        engine.spies.sendMessage
            .mockResolvedValueOnce({ kind: 'problem', problem: createProblem('forbidden') })
            .mockRejectedValueOnce(new TypeError('offline'));
        const app = await renderChat(engine);
        await app.user.click(composer());
        await app.user.keyboard('One{Enter}');
        expect(await screen.findByText('Not allowed')).toBeDefined();
        expect(engine.spies.listMessages).toHaveBeenCalledTimes(1);
        await app.user.keyboard('{Enter}');
        expect(await screen.findByText('Your message was not sent', {}, SETTLE_WAIT)).toBeDefined();
        expect((composer() as HTMLTextAreaElement).value).toBe('One');
    });

    it('returns to the bottom when the member sends while scrolled up', async () => {
        const { engine } = ownChatEngine();
        const app = await renderChat(engine);
        const region = history();
        Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 5000 });
        Object.defineProperty(region, 'clientHeight', { configurable: true, value: 500 });
        fireEvent.scroll(region, { target: { scrollTop: 1000 } });
        expect(await screen.findByRole('button', { name: 'Jump to latest' })).toBeDefined();

        await sendAndOpen(app, engine, 'Back to the end');
        expect(region.scrollTop).toBe(5000);
    });

    it('adds a line with Shift+Enter, ignores an empty message, and sends with the button', async () => {
        const { engine } = ownChatEngine();
        const app = await renderChat(engine);
        await app.user.click(composer());
        await app.user.keyboard('{Enter}');
        expect(engine.spies.sendMessage).not.toHaveBeenCalled();
        await app.user.keyboard('Line one{Shift>}{Enter}{/Shift}Line two');
        expect((composer() as HTMLTextAreaElement).value).toBe('Line one\nLine two');
        await app.user.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => {
            expect(engine.spies.sendMessage).toHaveBeenCalledWith(
                CHAT_ID,
                { content: 'Line one\nLine two' },
                expect.anything(),
            );
        });
    });
});

/** The engine took the message, but its answer never reached the browser. */
function loseAnswer(engine: ChatEngine, failure: 'network' | 'server' = 'network') {
    engine.spies.sendMessage.mockImplementationOnce(async (...args) => {
        await engine.real.sendMessage(...args);
        if (failure === 'server') return { kind: 'problem', problem: createProblem('internal-error') };
        throw new TypeError('connection reset');
    });
}

const sentContents = (engine: ChatEngine) => engine.spies.sendMessage.mock.calls.map(([, body]) => body.content);
const checkAgain = () => screen.findByRole('button', { name: 'Check again' }, SETTLE_WAIT);

describe('chat panel moving between chats', { timeout: TIMEOUT_MS }, () => {
    function twoChats() {
        const own = seededConversation(CHAT_ID, 2, OWNER_ID);
        const other = seededConversation('chat-other', 2, OWNER_ID);
        const engine = createChatEngine({
            chats: [own.chat, { ...other.chat, title: 'The other chat' }],
            messages: [...own.messages, ...other.messages],
        });
        return { engine, control: controlReplyStreams(engine) };
    }

    it('leaves a streaming reply and a draft in their own chat', async () => {
        const { engine, control } = twoChats();
        const app = await renderChat(engine);
        await sendAndOpen(app, engine, 'Explain it');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Only for this chat' });
        });
        expect(await within(history()).findByText('Only for this chat')).toBeDefined();

        await act(() => app.router.navigate({ to: chatPath('chat-other') }));
        expect(await screen.findByRole('heading', { level: 2, name: 'The other chat' })).toBeDefined();
        await waitFor(() => {
            expect(within(history()).queryByText('Only for this chat')).toBeNull();
        });
        expect(control.latest().aborted()).toBe(true);
        expect((composer() as HTMLTextAreaElement).readOnly).toBe(false);
        expect(replyStop()).toBeNull();

        await app.user.click(composer());
        await app.user.keyboard('Half a thought');
        await act(() => app.router.navigate({ to: chatPath() }));
        await screen.findByRole('heading', { level: 2, name: 'Question 1' });
        await waitFor(() => {
            expect((composer() as HTMLTextAreaElement).value).toBe('');
        });
    });

    it('shows a reply that finished while the member was in another chat', async () => {
        const { engine, control } = twoChats();
        const app = await renderChat(engine);
        await sendAndOpen(app, engine, 'Explain it');
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Half' });
        });
        await within(history()).findByText('Half');
        await act(() => app.router.navigate({ to: chatPath('chat-other') }));
        expect(await screen.findByRole('heading', { level: 2, name: 'The other chat' })).toBeDefined();

        engine.spies.streamReply.mockImplementation((...args) => engine.real.streamReply(...args));
        await act(() => app.router.navigate({ to: chatPath() }));
        expect(await within(history()).findByText(/received: Explain it/, {}, SETTLE_WAIT)).toBeDefined();
    });
});

describe('chat panel unclear sends', { timeout: TIMEOUT_MS }, () => {
    it('finds a message the engine got after a dropped answer: no resend, one message, the reply followed', async () => {
        const { engine, control } = ownChatEngine();
        loseAnswer(engine);
        const app = await renderChat(engine);
        await app.user.click(composer());
        await app.user.keyboard('Did you get this?{Enter}');

        await waitFor(() => {
            expect(engine.spies.streamReply).toHaveBeenCalledTimes(1);
        });
        expect(within(history()).getAllByText('Did you get this?')).toHaveLength(1);
        expect((composer() as HTMLTextAreaElement).value).toBe('');
        expect(screen.queryByText('Your message was not sent')).toBeNull();
        expect(sentContents(engine)).toEqual(['Did you get this?']);
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'Yes' });
        });
        expect(await within(history()).findByText('Yes')).toBeDefined();
    });

    it('treats a 5xx like a dropped answer: the engine may have kept the message', async () => {
        const { engine } = ownChatEngine();
        loseAnswer(engine, 'server');
        const app = await renderChat(engine);
        await app.user.click(composer());
        await app.user.keyboard('Half done{Enter}');
        await waitFor(() => {
            expect(engine.spies.streamReply).toHaveBeenCalledTimes(1);
        });
        expect(screen.queryByText('Your message was not sent')).toBeNull();
        expect(within(history()).getAllByText('Half done')).toHaveLength(1);
    });

    it('gives the text back only after the check shows the message did not arrive, and a resend sends once', async () => {
        const { engine } = ownChatEngine();
        engine.spies.sendMessage.mockRejectedValueOnce(new TypeError('offline'));
        const app = await renderChat(engine);
        await app.user.click(composer());
        await app.user.keyboard('Lost on the way{Enter}');
        expect((composer() as HTMLTextAreaElement).value).toBe('');
        expect(await screen.findByText('Your message was not sent', {}, SETTLE_WAIT)).toBeDefined();
        expect((composer() as HTMLTextAreaElement).value).toBe('Lost on the way');
        expect(within(history()).queryByText('Lost on the way')).toBeNull();

        await app.user.keyboard('{Enter}');
        await waitFor(() => {
            expect(engine.spies.streamReply).toHaveBeenCalledTimes(1);
        });
        expect(within(history()).getAllByText('Lost on the way')).toHaveLength(1);
        expect(sentContents(engine)).toEqual(['Lost on the way', 'Lost on the way']);
    });

    it('does not take an earlier identical message, or someone else’s, for the one that went missing', async () => {
        const own = seededConversation(CHAT_ID, 2, OWNER_ID);
        const engine = createChatEngine({ chats: [own.chat], messages: own.messages });
        controlReplyStreams(engine);
        engine.spies.sendMessage.mockRejectedValueOnce(new TypeError('offline'));
        const app = await renderChat(engine);
        // Another member wrote the same words while the send was failing.
        engine.spies.listMessages.mockImplementation(async (...args) => {
            const response = await engine.real.listMessages(...args);
            if (response.kind !== 'ok') return response;
            const twin = {
                id: 'message-from-someone-else',
                chatId: own.chat.id,
                role: 'user',
                content: 'Question 1',
                status: 'completed',
                createdBy: SECOND_MEMBER_ID,
                createdAt: own.messages[0]?.createdAt,
            };
            return {
                ...response,
                data: { ...response.data, items: [twin, ...response.data.items] },
            } as typeof response;
        });
        await app.user.click(composer());
        await app.user.keyboard('Question 1{Enter}');
        expect(await screen.findByText('Your message was not sent', {}, SETTLE_WAIT)).toBeDefined();
        expect((composer() as HTMLTextAreaElement).value).toBe('Question 1');
    });

    it('says it cannot tell when the check fails too, blocks a resend, and Check again settles it', async () => {
        const { engine } = ownChatEngine();
        loseAnswer(engine);
        const app = await renderChat(engine);
        engine.spies.listMessages.mockRejectedValueOnce(new TypeError('offline'));
        await app.user.click(composer());
        await app.user.keyboard('Anyone there?{Enter}');

        const again = await checkAgain();
        expect(within(history()).getByText('Couldn’t check whether this arrived')).toBeDefined();
        expect(screen.queryByText('Your message was not sent')).toBeNull();
        expect(within(history()).getByText('Anyone there?')).toBeDefined();
        expect((composer() as HTMLTextAreaElement).readOnly).toBe(true);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
        await app.user.click(composer());
        await app.user.keyboard('{Enter}');
        expect(engine.spies.sendMessage).toHaveBeenCalledTimes(1);

        await app.user.click(again);
        await waitFor(() => {
            expect(engine.spies.streamReply).toHaveBeenCalledTimes(1);
        });
        expect(within(history()).getAllByText('Anyone there?')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
        expect(engine.spies.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('keeps saying it cannot tell while the check keeps failing, then gives the text back once it can tell', async () => {
        const { engine } = ownChatEngine();
        engine.spies.sendMessage.mockRejectedValueOnce(new TypeError('offline'));
        const app = await renderChat(engine);
        engine.spies.listMessages
            .mockRejectedValueOnce(new TypeError('offline'))
            .mockResolvedValueOnce({ kind: 'problem', problem: createProblem('internal-error') });
        await app.user.click(composer());
        await app.user.keyboard('Still down{Enter}');

        await app.user.click(await checkAgain());
        const again = await checkAgain();
        expect((composer() as HTMLTextAreaElement).value).toBe('');

        await app.user.click(again);
        expect(await screen.findByText('Your message was not sent', {}, SETTLE_WAIT)).toBeDefined();
        expect((composer() as HTMLTextAreaElement).value).toBe('Still down');
        expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
        expect(within(history()).queryByText('Still down')).toBeNull();
    });
});

describe('chat panel access', { timeout: TIMEOUT_MS }, () => {
    it('follows a reply still generating on load when effects run twice, as in StrictMode', async () => {
        const own = seededConversation(CHAT_ID, 3, OWNER_ID);
        const streaming = own.messages.map((message, index) =>
            index === 2 ? { ...message, role: 'agent' as const, content: '', status: 'streaming' as const } : message,
        );
        const engine = createChatEngine({ chats: [own.chat], messages: streaming });
        const control = controlReplyStreams(engine);
        configure({ reactStrictMode: true });
        try {
            await renderChat(engine);
            await waitFor(() => {
                expect(control.streams.at(-1)?.stream.aborted()).toBe(false);
            });
            act(() => {
                control.latest().push({ type: 'delta', seq: 1, text: 'Still here' });
            });
            expect(await screen.findByText('Still here')).toBeDefined();
        } finally {
            configure({ reactStrictMode: false });
        }
    });

    it('shows other members’ and visitors’ chats read-only, and follows a reply still generating there', async () => {
        const jana = seededConversation('chat-jana', 2, SECOND_MEMBER_ID);
        const visitor = seededConversation('chat-visitor', 3, null);
        const streaming = visitor.messages.map((message, index) =>
            index === 2 ? { ...message, role: 'agent' as const, content: '', status: 'streaming' as const } : message,
        );
        const engine = createChatEngine({
            chats: [jana.chat, { ...visitor.chat, title: 'Pricing question' }],
            messages: [...jana.messages, ...streaming],
        });
        const control = controlReplyStreams(engine);
        renderWithProviders({ path: chatPath('chat-jana'), engineApi: engine.client });
        expect(await screen.findByText('Only the member who started this chat can write in it.')).toBeDefined();
        expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();

        renderWithProviders({ path: chatPath('chat-visitor'), engineApi: engine.client });
        expect(await screen.findByRole('heading', { level: 2, name: 'Pricing question' })).toBeDefined();
        await waitFor(() => {
            expect(engine.spies.streamReply).toHaveBeenCalledWith(
                'chat-visitor',
                'chat-visitor-m00003',
                {},
                expect.anything(),
            );
        });
        act(() => {
            control.latest().push({ type: 'delta', seq: 1, text: 'From the start' });
        });
        expect(await screen.findByText('From the start')).toBeDefined();
        expect(replyStop()).toBeNull();
    });

    it('writes nothing without chats.write, even in the member’s own chat', async () => {
        const own = seededConversation(CHAT_ID, 2, OWNER_ID);
        const engine = createChatEngine({
            chats: [own.chat],
            messages: own.messages,
            permissions: ['agents.read', 'chats.read'],
        });
        renderWithProviders({ path: chatPath(), engineApi: engine.client });
        await screen.findByRole('heading', { level: 2, name: 'Question 1' });
        expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
        expect(screen.queryByText('Only the member who started this chat can write in it.')).toBeNull();
    });
});

describe('chat layout', { timeout: TIMEOUT_MS }, () => {
    it('fits the screen in a one-line agent header, with the composer under the history', async () => {
        const own = seededConversation(CHAT_ID, 2, OWNER_ID);
        const engine = createChatEngine({ chats: [own.chat], messages: own.messages });
        renderWithProviders({ path: chatPath(), engineApi: engine.client });
        await screen.findByRole('heading', { level: 2, name: 'Question 1' });
        const section = screen.getAllByRole('heading', { level: 1 })[0]?.closest('section');
        // The frame takes the height the shell leaves; the panel and its composer flex into it.
        expect(section?.className).toContain('h-(--main-fill-height)');
        const header = section?.querySelector('header') as HTMLElement;
        expect(within(header).queryByRole('link', { name: 'Chat' })).toBeNull();
        expect(screen.getByRole('tabpanel').className).toContain('flex-1');
        const composer = screen.getByRole('textbox', { name: 'Message' });
        expect(composer.getAttribute('rows')).toBe('1');
        expect(document.getElementById(composer.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
            'Enter sends, Shift+Enter adds a line, Esc stops a reply.',
        );
    });
});

describe('chat authors', { timeout: TIMEOUT_MS }, () => {
    const authorsShown = async () => {
        const history = await screen.findByRole('region', { name: 'Messages' });
        await within(history).findByText('Question 1');
        return [...history.querySelectorAll('article > header')].map((header) => !header.classList.contains('sr-only'));
    };

    it('names who wrote each turn, except the member’s own words, which only screen readers hear', async () => {
        const own = seededConversation(CHAT_ID, 4, OWNER_ID);
        const jana = seededConversation('chat-jana', 3, SECOND_MEMBER_ID);
        const engine = createChatEngine({
            chats: [own.chat, jana.chat],
            messages: [...own.messages, ...jana.messages],
        });

        const mine = renderWithProviders({ path: chatPath(), engineApi: engine.client });
        expect(await authorsShown()).toEqual([false, true, false, true]);
        mine.unmount();

        renderWithProviders({ path: chatPath('chat-jana'), engineApi: engine.client });
        expect(await authorsShown()).toEqual([true, true, true]);
    });
});

describe('chat panel states', { timeout: TIMEOUT_MS }, () => {
    it('shows an empty history and a history that failed to load, with retry', async () => {
        const empty = seededConversation('chat-empty', 0, OWNER_ID);
        const engine = createChatEngine({ chats: [{ ...empty.chat, title: 'Fresh' }] });
        engine.spies.listMessages.mockResolvedValue({ kind: 'problem', problem: createProblem('validation-failed') });
        const app = renderWithProviders({ path: chatPath('chat-empty'), engineApi: engine.client });
        expect(await screen.findByText('Messages could not be loaded')).toBeDefined();
        engine.spies.listMessages.mockRestore();
        await app.user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('No messages yet.')).toBeDefined();
    });

    it('says "chat not found" for an unknown chat, a malformed ID and another agent’s chat', async () => {
        const other = seededConversation('chat-elsewhere', 2, OWNER_ID);
        const engine = createChatEngine({ chats: [{ ...other.chat, agentId: 'agent-grace' }] });
        renderWithProviders({ path: chatPath('chat-missing'), engineApi: engine.client });
        expect(await screen.findByRole('heading', { name: 'Chat not found' })).toBeDefined();
        renderWithProviders({ path: chatPath('bad%20id'), engineApi: engine.client });
        await waitFor(() => {
            expect(screen.getAllByRole('heading', { name: 'Chat not found' })).toHaveLength(2);
        });
        renderWithProviders({ path: chatPath('chat-elsewhere'), engineApi: engine.client });
        await waitFor(() => {
            expect(screen.getAllByRole('heading', { name: 'Chat not found' })).toHaveLength(3);
        });
    });

    it('selects the Chat tab on a chat page and has no axe violations', async () => {
        const { engine } = ownChatEngine(4);
        const { container } = await renderChat(engine);
        expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
        await expectNoAxeViolations(container);
    });
});

describe('chat panel events', { timeout: TIMEOUT_MS }, () => {
    it('fetches the newest page when the engine reports a message the panel does not have', async () => {
        const { engine } = ownChatEngine();
        await renderChat(engine);
        expect(engine.spies.listMessages).toHaveBeenCalledTimes(1);
        // Another tab of the same member sends a message.
        await engine.client.chats.sendMessage(
            CHAT_ID as never,
            { content: 'From elsewhere' },
            AbortSignal.timeout(1000),
        );
        expect(await within(history()).findByText('From elsewhere')).toBeDefined();
        expect(engine.spies.listMessages.mock.calls.at(-1)?.[1]).toEqual({ limit: 50 });
    });
});

describe('chat panel long histories', { timeout: TIMEOUT_MS }, () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('mounts only the visible window of 2,000 messages, keeps its place as older pages load, and jumps to the latest', async () => {
        vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
        const long = seededConversation('chat-long', 2000, OWNER_ID);
        const engine = createChatEngine({ chats: [long.chat], messages: long.messages });
        const app = renderWithProviders({ path: chatPath('chat-long'), engineApi: engine.client });
        await screen.findByRole('heading', { level: 2, name: 'Question 1' });
        const region = history();
        const rows = () => region.querySelectorAll('article');
        fireEvent.scroll(region);
        expect(await within(region).findByText('Answer 2000')).toBeDefined();
        expect(rows().length).toBeGreaterThan(0);
        expect(rows().length).toBeLessThan(40);
        expect(engine.spies.listMessages).toHaveBeenCalledTimes(1);

        region.scrollTop = 0;
        fireEvent.scroll(region);
        await waitFor(() => {
            expect(engine.spies.listMessages).toHaveBeenCalledTimes(2);
        });
        expect(engine.spies.listMessages.mock.calls[1]?.[1]).toMatchObject({ limit: 50 });
        expect(typeof engine.spies.listMessages.mock.calls[1]?.[1].cursor).toBe('string');
        // The 50 older messages went in above: the reader is moved down by their height, not left at the top.
        await waitFor(() => {
            expect(region.scrollTop).toBe(50 * ESTIMATED_ROW_PX);
        });
        expect(rows().length).toBeLessThan(40);

        const jump = screen.getByRole('button', { name: 'Jump to latest' });
        jump.focus();
        await app.user.keyboard('{Enter}');
        fireEvent.scroll(region);
        expect(await within(region).findByText('Answer 2000')).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
        expect(document.activeElement).toBe(composer());
        await expectNoAxeViolations(region);
    });

    it('mounts every message of a short chat and loads older ones from the button', async () => {
        const chat = seededConversation('chat-medium', 120, OWNER_ID);
        const engine = createChatEngine({ chats: [chat.chat], messages: chat.messages });
        const app = renderWithProviders({ path: chatPath('chat-medium'), engineApi: engine.client });
        await screen.findByRole('heading', { level: 2, name: 'Question 1' });
        await waitFor(() => {
            expect(history().querySelectorAll('article')).toHaveLength(50);
        });
        await app.user.click(within(history()).getByRole('button', { name: 'Show more' }));
        await waitFor(() => {
            expect(history().querySelectorAll('article')).toHaveLength(100);
        });
    });
});
