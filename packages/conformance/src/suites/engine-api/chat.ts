import { ENGINE_API_ROUTES } from '@ptbk/engine-api';
import type { ChatEntry, Message, ReplyStreamEvent } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, fail } from '../../check';
import { CHAT_MESSAGE } from '../../fixtures/books';
import { randomToken } from '../../random';
import type { StreamItem } from './api';
import { SUITE } from './support';
import type { World } from './world';
import { REPLY_TIMEOUT_MS, createWorld, replyAfter } from './world';

const R = ENGINE_API_ROUTES;
const USER = { kind: 'user', key: 'user' } as const;

function terminal(item: StreamItem): boolean {
    return item.event.type === 'completed' || item.event.type === 'failed';
}

export async function send(
    world: World,
    body: { readonly content: string; readonly requestKey?: string } = { content: CHAT_MESSAGE },
): Promise<{ readonly chatId: string; readonly sent: Message; readonly reply: Message }> {
    const { id: chatId } = await world.chat();
    const { message: sent } = await world.owner.ok(R.sendChatMessage, { params: { chatId }, body });
    if (sent.author.kind !== 'user' || sent.content !== body.content) {
        fail('POST /chats/{chatId}/messages: the answer is not the message sent, written by the User');
    }
    return { chatId, sent, reply: await replyAfter(world.owner, chatId, sent.id) };
}

/** Oldest first, as the thread reads. */
export async function entries(world: World, chatId: string): Promise<ChatEntry[]> {
    const page = await world.owner.ok(R.listChatEntries, { params: { chatId }, query: { limit: 100 } });
    return [...page.items].reverse();
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

const keyOf = (who: { readonly kind: string; readonly key: string }): string => `${who.kind}:${who.key}`;

export const CHAT_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.chat.reply-stream',
        suite: SUITE,
        title: 'A reply streams as SSE and its final message equals the stored one',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const { chatId, reply } = await send(world);
            const where = 'GET /chats/{chatId}/messages/{messageId}/stream';
            const stream = await world.owner.stream(
                R.streamChatReply,
                { params: { chatId, messageId: reply.id } },
                { maxMs: REPLY_TIMEOUT_MS },
            );
            if (!stream.ended) fail(`${where}: the reply did not end within ${String(REPLY_TIMEOUT_MS)} ms`);
            checkSequence(stream.items, findings, where);
            const last = stream.items.at(-1)?.event as ReplyStreamEvent | undefined;
            if (last?.type !== 'completed') {
                findings.add(`${where}: the reply ended with ${last?.type ?? 'nothing'}, not completed`);
                return findings.outcome();
            }
            if (last.message.id !== reply.id) findings.add(`${where}: completed names another message`);
            if (last.message.author.kind !== 'agent' || last.message.status !== 'completed') {
                findings.add(
                    `${where}: completed carries a ${last.message.author.kind} message in status ${last.message.status}`,
                );
            }
            const stored = (await entries(world, chatId)).find(({ id }) => id === reply.id);
            if (stored === undefined) findings.add('GET /chats/{chatId}/entries: the reply is not stored');
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
            const { chatId, reply } = await send(world);
            const where = 'GET /chats/{chatId}/messages/{messageId}/stream';
            const request = { params: { chatId, messageId: reply.id } };
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
    {
        id: 'engine-api.chat.thread-joins',
        suite: SUITE,
        title: 'A new thread lists the User and its agent as members, and every author joins before writing',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const agent = await world.agent();
            const chat = await world.chat();
            const members = chat.members.map(keyOf);
            if (members[0] !== keyOf(USER) || members[1] !== keyOf({ kind: 'agent', key: agent.id })) {
                findings.add(`POST /chats: members are [${members.join(', ')}], not the User and then the agent`);
            }
            if (chat.status !== 'open') findings.add(`POST /chats: a new thread is ${chat.status}, not open`);
            const { chatId } = await send(world);
            const joined = new Set<string>();
            for (const entry of await entries(world, chatId)) {
                if (entry.type === 'joined') joined.add(keyOf(entry.participant));
                if (entry.type === 'message' && !joined.has(keyOf(entry.author))) {
                    findings.add(`GET /chats/{chatId}/entries: ${keyOf(entry.author)} writes before joining`);
                }
            }
            const listed = new Set((await world.owner.ok(R.getChat, { params: { chatId } })).members.map(keyOf));
            for (const member of joined) {
                if (!listed.has(member)) findings.add(`GET /chats/{chatId}: ${member} joined but is not a member`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.chat.authorship',
        suite: SUITE,
        title: 'A sent message is the User’s and names the member who sent it; a reply names its real agent',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const me = await world.me();
            const { chatId, sent, reply } = await send(world);
            if (keyOf(sent.author) !== keyOf(USER)) findings.add(`the sent message's author is ${keyOf(sent.author)}`);
            if (sent.createdBy !== me.memberId) findings.add('the sent message does not name the member who sent it');
            if (reply.createdBy !== null) findings.add('an agent message names a member in createdBy');
            const chat = await world.owner.ok(R.getChat, { params: { chatId } });
            const agents = chat.members.filter(({ kind }) => kind === 'agent').map(keyOf);
            if (!agents.includes(keyOf(reply.author))) {
                findings.add(`the reply's author ${keyOf(reply.author)} is not an agent of the thread`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.chat.idempotent-send',
        suite: SUITE,
        title: 'A repeated requestKey answers the original message and saves nothing; another request with it is 409',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const requestKey = randomToken(ctx.random, 24);
            const { chatId, sent } = await send(world, { content: CHAT_MESSAGE, requestKey });
            const repeat = await world.owner.call(R.sendChatMessage, {
                params: { chatId },
                body: { content: CHAT_MESSAGE, requestKey },
            });
            if (repeat.kind !== 'ok') findings.add(`a repeated requestKey answered ${repeat.problem.code}`);
            else if (repeat.data.message.id !== sent.id) findings.add('a repeated requestKey saved another message');
            const users = (await entries(world, chatId)).filter(
                (entry) => entry.type === 'message' && entry.author.kind === 'user',
            );
            if (users.length !== 1) {
                findings.add(`the thread holds ${String(users.length)} User messages after a repeated send`);
            }
            const other = await world.owner.call(R.sendChatMessage, {
                params: { chatId },
                body: { content: `${CHAT_MESSAGE} (changed)`, requestKey },
            });
            if (other.kind !== 'problem' || other.problem.code !== 'request-key-reused') {
                const got = other.kind === 'ok' ? 'ok' : other.problem.code;
                findings.add(`the same requestKey with other content answered ${got}, not 409 request-key-reused`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.chat.read-and-seen',
        suite: SUITE,
        title: 'Marking a thread read clears the caller’s unread; marking messages seen answers nothing and is idempotent',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const { chatId, reply } = await send(world);
            const read = await world.owner.ok(R.markChatRead, { params: { chatId } });
            if (read.unread !== 0) findings.add(`POST /chats/{chatId}/read: unread is ${String(read.unread)}, not 0`);
            const body = { messageIds: [reply.id] };
            const seen = await world.owner.ok(R.markChatSeen, { params: { chatId }, body });
            const again = await world.owner.ok(R.markChatSeen, { params: { chatId }, body });
            if (JSON.stringify(seen.questions) !== JSON.stringify(again.questions) || seen.status !== again.status) {
                findings.add('POST /chats/{chatId}/seen: seeing the same messages again changed the thread');
            }
            if (seen.questions.some((question) => question.messageId === reply.id && !question.seen)) {
                findings.add('POST /chats/{chatId}/seen: a displayed question is still unseen');
            }
            if (read.questions.length !== seen.questions.length) {
                findings.add('POST /chats/{chatId}/seen: seeing answered or withdrew a question');
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.chat.default-chatter',
        suite: SUITE,
        title: 'A thread without a named agent starts with Chatter, or is refused with 409 chatter-missing',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const created = await world.owner.call(R.createChat, { body: { title: world.name('chatter') } });
            if (created.kind === 'problem') {
                if (created.problem.code !== 'chatter-missing') {
                    findings.add(`POST /chats without an agent answered ${created.problem.code}`);
                }
                return findings.outcome();
            }
            const agents = created.data.members.filter(({ kind }) => kind === 'agent').map(({ name }) => name);
            if (agents.length !== 1 || agents[0] !== 'Chatter') {
                findings.add(`POST /chats without an agent started with [${agents.join(', ')}], not Chatter`);
            }
            return findings.outcome();
        },
    },
];
