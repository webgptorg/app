import { ChatId, MessageId, Timestamp } from '@ptbk/engine-api';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations } from '../../testing/axe';
import { OWNER_ID } from '../../testing/agents-engine';
import {
    CHAT_AGENT_ID,
    completedReply,
    controlReplyStreams,
    createChatEngine,
    seededConversation,
} from '../../testing/chat-engine';
import type { ChatEngine } from '../../testing/chat-engine';
import { renderWithProviders } from '../../testing/render-with-providers';

// Each test renders the whole app on the in-memory engine; a shared CI runner is several times slower than a laptop.
const TIMEOUT_MS = 20_000;

const CHAT_ID = 'chat-own';
/** An engine-style thread ID: its name, spaces and all; its messages are `<chat>#<position>`. */
const QUESTION_CHAT = 'Shipping — 2026-10-01 10:00:00';
const ADA = { kind: 'agent', key: CHAT_AGENT_ID } as const;

const announcer = () => document.querySelector<HTMLElement>('[aria-live="polite"][aria-atomic="true"]');
const composer = () => screen.getByRole('textbox', { name: 'Message' });
const history = () => screen.getByRole('region', { name: 'Messages' });
const replyStop = () =>
    screen.queryAllByRole('button', { name: 'Stop' }).find((button) => button.closest('form') !== null) ?? null;

function ownChatEngine(count = 2) {
    const engine = createChatEngine({ chats: [seededConversation(CHAT_ID, count, OWNER_ID)] });
    return { engine, control: controlReplyStreams(engine) };
}

async function renderThread(engine: ChatEngine, chatId = CHAT_ID) {
    const app = renderWithProviders({ path: `/chats/${encodeURIComponent(chatId)}`, engineApi: engine.client });
    await screen.findByRole('region', { name: 'Messages' });
    return app;
}

async function send(app: Awaited<ReturnType<typeof renderThread>>, text: string) {
    await app.user.click(composer());
    await app.user.keyboard(text);
    await app.user.keyboard('{Enter}');
}

/** Every observed element counts as on screen at once, as if the reader scrolled to it. */
function everythingOnScreen(): Element[] {
    const observed: Element[] = [];
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            private readonly callback: IntersectionObserverCallback;
            constructor(callback: IntersectionObserverCallback) {
                this.callback = callback;
            }
            observe(target: Element) {
                observed.push(target);
                this.callback(
                    [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
                    this as never,
                );
            }
            disconnect() {
                return undefined;
            }
        },
    );
    return observed;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('thread view', { timeout: TIMEOUT_MS }, () => {
    it('shows the title, who joined and who wrote each message, as plain text', async () => {
        const { engine } = ownChatEngine();
        await renderThread(engine);
        expect(screen.getByRole('heading', { level: 1, name: 'Chat with Ada' })).toBeDefined();
        expect(within(history()).getByText('Ada joined')).toBeDefined();
        expect(within(history()).getByText('Answer 2')).toBeDefined();
        expect(within(history()).getAllByText('Ada').length).toBeGreaterThan(0);
        await expectNoAxeViolations(document.body);
    });

    it('follows the reply that answers a sent message, in order, as plain text until it completes, and announces it once', async () => {
        const { engine, control } = ownChatEngine();
        const app = await renderThread(engine);
        await send(app, 'Explain it');
        await waitFor(() => {
            expect(engine.spies.streamReply).toHaveBeenCalledTimes(1);
        });
        const replyId = engine.spies.streamReply.mock.calls[0]?.[1];
        expect(replyId).toBe(`${CHAT_ID}#4`);
        const stream = control.latest();
        act(() => {
            stream.push({ type: 'delta', seq: 1, text: 'This is **bo' });
            stream.push({ type: 'delta', seq: 1, text: 'This is **bo' });
            stream.push({ type: 'delta', seq: 2, text: 'ld** news' });
        });
        expect(await within(history()).findByText('This is **bold** news')).toBeDefined();
        expect(within(history()).queryByText('bold', { selector: 'strong' })).toBeNull();
        expect(within(history()).getByText('Replying…')).toBeDefined();
        act(() => {
            stream.push({
                type: 'completed',
                message: completedReply(
                    {
                        id: MessageId.parse(`${CHAT_ID}#4`),
                        chatId: ChatId.parse(CHAT_ID),
                        createdAt: Timestamp.parse('2026-10-01T00:00:00.000Z'),
                    },
                    'This is **bold** news',
                ),
            });
        });
        await waitFor(() => {
            expect(within(history()).queryByText('Replying…')).toBeNull();
        });
        expect(await within(history()).findByText('bold', { selector: 'strong' })).toBeDefined();
        await waitFor(() => {
            expect(announcer()?.textContent).toBe('Ada replied');
        });
    });

    it('sends again under the same request key when nobody knows whether a message arrived, and saves it once', async () => {
        const { engine } = ownChatEngine();
        engine.spies.sendMessage.mockImplementationOnce(async (chatId, body, signal) => {
            await engine.real.sendMessage(chatId, body, signal);
            throw new TypeError('connection lost');
        });
        const app = await renderThread(engine);
        await send(app, 'Only once');
        await app.user.click(await screen.findByRole('button', { name: 'Check again' }));
        await waitFor(() => {
            expect(engine.spies.sendMessage).toHaveBeenCalledTimes(2);
        });
        const [first, second] = engine.spies.sendMessage.mock.calls.map(([, body]) => body);
        expect(first?.requestKey).toBeDefined();
        expect(second?.requestKey).toBe(first?.requestKey);
        await waitFor(() => {
            expect(within(history()).getAllByText('Only once')).toHaveLength(1);
        });
        expect(within(history()).queryByText('Couldn’t check whether this arrived')).toBeNull();
    });

    it('stops a reply in progress from the composer', async () => {
        const { engine } = ownChatEngine();
        const app = await renderThread(engine);
        await send(app, 'Go');
        await waitFor(() => {
            expect(replyStop()).not.toBeNull();
        });
        const stop = replyStop();
        if (stop === null) throw new Error('no Stop');
        await app.user.click(stop);
        await waitFor(() => {
            expect(engine.spies.cancelReply).toHaveBeenCalledTimes(1);
        });
        expect(await within(history()).findByText('Stopped')).toBeDefined();
    });
});

describe('questions to the User', { timeout: TIMEOUT_MS }, () => {
    it('shows the question in the thread, marks it seen once on screen, and an answer clears it', async () => {
        const observed = everythingOnScreen();
        const engine = createChatEngine({
            chats: [
                {
                    id: QUESTION_CHAT,
                    createdAt: '2026-10-01T10:00:00.000Z',
                    entries: [
                        { type: 'message', author: ADA, content: 'Looking at shipping.' },
                        { type: 'message', author: ADA, content: '+@User Do we ship to Brno?', choices: ['Yes', 'No'] },
                    ],
                },
            ],
        });
        controlReplyStreams(engine);
        const app = await renderThread(engine, QUESTION_CHAT);
        expect(within(history()).getByText('Waiting for your answer')).toBeDefined();
        await waitFor(() => {
            expect(engine.spies.markRead).toHaveBeenCalled();
        });
        await waitFor(() => {
            expect(engine.spies.markSeen).toHaveBeenCalledWith(
                QUESTION_CHAT,
                { messageIds: [`${QUESTION_CHAT}#2`] },
                expect.anything(),
            );
        });
        expect(observed.length).toBeGreaterThan(0);
        await app.user.click(within(history()).getByRole('button', { name: 'Yes' }));
        await waitFor(() => {
            expect(engine.spies.sendMessage).toHaveBeenCalledWith(
                QUESTION_CHAT,
                expect.objectContaining({ content: 'Yes', replyTo: `${QUESTION_CHAT}#2` }),
                expect.anything(),
            );
        });
        await waitFor(() => {
            expect(within(history()).queryByText('Waiting for your answer')).toBeNull();
        });
    });

    it('shows a member who may only read the question, without a way to answer it', async () => {
        const engine = createChatEngine({
            permissions: ['agents.read', 'chats.read', 'members.read'],
            chats: [
                {
                    id: 'chat-q',
                    createdAt: '2026-10-01T10:00:00.000Z',
                    entries: [{ type: 'message', author: ADA, content: '+@User Ship it?', choices: ['Yes'] }],
                },
            ],
        });
        await renderThread(engine, 'chat-q');
        expect(within(history()).getByText('Waiting for your answer')).toBeDefined();
        expect(within(history()).queryByRole('button', { name: 'Yes' })).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    });
});
