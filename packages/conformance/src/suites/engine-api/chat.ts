import { ENGINE_API_ROUTES } from '@ptbk/engine-api';
import type { Message, ReplyStreamEvent } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, fail } from '../../check';
import { CHAT_MESSAGE } from '../../fixtures/books';
import type { StreamItem } from './api';
import { SUITE } from './support';
import type { World } from './world';
import { REPLY_TIMEOUT_MS, createWorld } from './world';

const R = ENGINE_API_ROUTES;

function terminal(item: StreamItem): boolean {
    return item.event.type === 'completed' || item.event.type === 'failed';
}

async function send(world: World): Promise<{ readonly chatId: string; readonly replyMessageId: string }> {
    const { id: chatId } = await world.chat();
    const sent = await world.owner.ok(R.sendChatMessage, { params: { chatId }, body: { content: CHAT_MESSAGE } });
    if (sent.userMessage.role !== 'user' || sent.userMessage.content !== CHAT_MESSAGE) {
        fail('POST /chats/{chatId}/messages: userMessage is not the message sent');
    }
    return { chatId, replyMessageId: sent.replyMessageId };
}

async function storedMessage(world: World, chatId: string, messageId: string): Promise<Message | undefined> {
    const page = await world.owner.ok(R.listChatMessages, { params: { chatId }, query: { limit: 100 } });
    return page.items.find(({ id }) => id === messageId);
}

function seqOf(item: StreamItem): number {
    return (item.event as Extract<ReplyStreamEvent, { type: 'delta' }>).seq;
}

/** Deltas count up from 1, each carrying its `seq` as the SSE id, and exactly one terminal event ends the stream. */
function checkSequence(items: readonly StreamItem[], findings: Findings, where: string): void {
    let previous = 0;
    for (const item of items.filter(({ event }) => event.type === 'delta')) {
        const { id } = item;
        const seq = seqOf(item);
        if (seq <= previous) findings.add(`${where}: delta seq ${String(seq)} after ${String(previous)}`);
        if (id !== String(seq)) findings.add(`${where}: delta seq ${String(seq)} has SSE id ${id ?? 'none'}`);
        previous = seq;
    }
    const ends = items.filter(terminal).length;
    if (ends !== 1) findings.add(`${where}: ${String(ends)} terminal events instead of one`);
    else if (!terminal(items.at(-1) as StreamItem)) findings.add(`${where}: events follow the terminal event`);
}

export const CHAT_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.chat.reply-stream',
        suite: SUITE,
        title: 'A posted message streams its reply as SSE whose final message equals the stored one',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const { chatId, replyMessageId } = await send(world);
            const where = 'GET /chats/{chatId}/messages/{messageId}/stream';
            const stream = await world.owner.stream(
                R.streamChatReply,
                { params: { chatId, messageId: replyMessageId } },
                { maxMs: REPLY_TIMEOUT_MS },
            );
            if (!stream.ended) fail(`${where}: the reply did not end within ${String(REPLY_TIMEOUT_MS)} ms`);
            checkSequence(stream.items, findings, where);
            const last = stream.items.at(-1)?.event as ReplyStreamEvent | undefined;
            if (last?.type !== 'completed') {
                findings.add(`${where}: the reply ended with ${last?.type ?? 'nothing'}, not completed`);
                return findings.outcome();
            }
            if (last.message.id !== replyMessageId) findings.add(`${where}: completed names another message`);
            if (last.message.role !== 'agent' || last.message.status !== 'completed') {
                findings.add(
                    `${where}: completed carries a ${last.message.role} message in status ${last.message.status}`,
                );
            }
            const stored = await storedMessage(world, chatId, replyMessageId);
            if (stored === undefined) findings.add('GET /chats/{chatId}/messages: the reply is not stored');
            else if (JSON.stringify(stored) !== JSON.stringify(last.message)) {
                findings.add(`${where}: the completed message differs from the stored one`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.chat.resume-no-duplicates',
        suite: SUITE,
        title: 'Reconnecting to a reply with Last-Event-ID repeats no delta',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const { chatId, replyMessageId } = await send(world);
            const where = 'GET /chats/{chatId}/messages/{messageId}/stream';
            const request = { params: { chatId, messageId: replyMessageId } };
            let deltas = 0;
            const first = await world.owner.stream(R.streamChatReply, request, {
                maxMs: REPLY_TIMEOUT_MS,
                until: (item) => item.event.type === 'delta' && ++deltas >= 2,
            });
            const lastId = first.items.findLast(({ event }) => event.type === 'delta')?.id ?? null;
            if (lastId === null) fail(`${where}: the reply ended before its second delta, nothing to resume`);
            const second = await world.owner.stream(
                R.streamChatReply,
                { ...request, lastEventId: lastId },
                { maxMs: REPLY_TIMEOUT_MS },
            );
            const firstDeltas = first.items.filter(({ event }) => event.type === 'delta');
            const combined = [...firstDeltas, ...second.items];
            checkSequence(combined, findings, `${where} (resumed)`);
            const firstSeqs = new Set(firstDeltas.map(seqOf));
            const repeated = second.items.filter((item) => item.event.type === 'delta' && firstSeqs.has(seqOf(item)));
            if (repeated.length > 0)
                findings.add(`${where}: the resumed stream repeats ${String(repeated.length)} deltas`);
            return findings.outcome();
        },
    },
];
