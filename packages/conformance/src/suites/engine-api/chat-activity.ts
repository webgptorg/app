import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';
import type { Chat, ChatEntry, ChatTaskState, Message } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings } from '../../check';
import { ENTRY_PAGE, entries, send } from './chat';
import { SUITE } from './support';
import type { World } from './world';
import { REPLY_TIMEOUT_MS, createWorld } from './world';

const R = ENGINE_API_ROUTES;
/** Threads a check reads besides its own, so it meets what agents really did without walking a large project. */
const SAMPLE = 25;
const UNKNOWN_CHAT_ID = 'conformance-no-such-chat';
const FINISHED: ReadonlySet<ChatTaskState> = new Set(['completed', 'failed', 'cancelled', 'retired']);

const keyOf = (who: { readonly kind: string; readonly key: string }): string => `${who.kind}:${who.key}`;

/**
 * Phases and steps tell one story: only a `progress` message has steps and readable text, the User's messages have
 * no phase, and a `final` reply closes a turn whose `progress` came before it, from the same agent. The strict schema
 * already refuses a tool step without its tool. On a page cut short, a `final` may close a turn whose progress lies
 * beyond it, so an agent's first message on such a page is not judged.
 */
function checkTurns(findings: Findings, where: string, items: readonly ChatEntry[], complete: boolean): void {
    const openTurns = new Set<string>();
    const seen = new Set<string>();
    for (const message of items.filter((entry): entry is Message => entry.type === 'message')) {
        const who = keyOf(message.author);
        const judged = complete || seen.has(who);
        seen.add(who);
        const at = `${where}: message ${message.id}`;
        if (message.author.kind === 'user' && message.phase !== null) findings.add(`${at}: a User message has a phase`);
        if (message.phase !== 'progress' && message.steps.length > 0) {
            findings.add(`${at}: carries steps, but only a progress message has them`);
        }
        switch (message.phase) {
            case 'progress':
                if (message.content.trim() === '') findings.add(`${at}: a progress message without readable text`);
                openTurns.add(who);
                break;
            case 'final':
                if (!openTurns.delete(who) && judged) findings.add(`${at}: a final reply without progress before it`);
                break;
            case null:
                openTurns.delete(who);
                break;
        }
    }
}

/** Who works now, which tasks the thread links and its recheck agree with each other and with the thread's entries. */
async function checkThread(world: World, findings: Findings, chat: Chat, items: readonly ChatEntry[]): Promise<void> {
    const where = `thread ${chat.id}`;
    const agents = new Set(chat.members.filter(({ kind }) => kind === 'agent').map(keyOf));
    for (const working of chat.working) {
        if (!agents.has(keyOf(working.author))) {
            findings.add(`${where}: ${keyOf(working.author)} works on a reply, but is not an agent of the thread`);
        }
    }
    // Entries are read one page deep, so only a thread that short is seen whole.
    const complete = items.length < ENTRY_PAGE;
    const linked = new Set(items.flatMap((entry) => (entry.type === 'linked' ? [entry.task] : [])));
    const names = new Set<string>();
    const tasksOffered = supports(await world.engine(), KNOWN_CAPABILITIES.tasks);
    for (const task of chat.tasks) {
        const at = `${where}: task ${task.name}`;
        if (names.has(task.name)) findings.add(`${at}: listed twice`);
        names.add(task.name);
        if (complete && !linked.has(task.name)) findings.add(`${at}: no linked entry brings it in`);
        // A finished task may have lost its times; an unfinished one never has an end.
        if (task.endedAt !== null && !FINISHED.has(task.state)) {
            findings.add(`${at}: is ${task.state}, yet ended at ${task.endedAt}`);
        }
        if (task.endedAt !== null && task.startedAt !== null && task.endedAt < task.startedAt) {
            findings.add(`${at}: ended before it started`);
        }
        if (task.commit !== null && task.state !== 'completed')
            findings.add(`${at}: a ${task.state} task has a commit`);
        if (task.taskId === null) continue;
        if (!tasksOffered) {
            findings.add(`${at}: names a task ID, but the engine does not offer tasks@1`);
            continue;
        }
        const resolved = await world.owner.call(R.getTask, { params: { taskId: task.taskId } });
        if (resolved.kind === 'problem') findings.add(`${at}: its taskId answers ${resolved.problem.code}`);
        else if (resolved.data.name !== task.name) findings.add(`${at}: its taskId is the task ${resolved.data.name}`);
    }
    for (const name of linked) {
        if (!names.has(name)) findings.add(`${where}: the linked task ${name} is not among the thread's tasks`);
    }
    checkTurns(findings, where, items, complete);
}

/** The newest threads of the engine, whatever created them; this run's own threads are among them. */
async function sampleThreads(world: World): Promise<readonly Chat[]> {
    return (await world.owner.ok(R.listChats, { query: { limit: SAMPLE } })).items;
}

export const CHAT_ACTIVITY_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.chat.reply-turn',
        suite: SUITE,
        title: 'A finished reply no longer works, and its phase follows the turn: final after progress, else none',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const { chatId, sent, reply } = await send(world);
            const where = `thread ${chatId}`;
            const stream = await world.owner.stream(
                R.streamChatReply,
                { params: { chatId, messageId: reply.id } },
                { maxMs: REPLY_TIMEOUT_MS },
            );
            if (!stream.ended) findings.add(`${where}: the reply did not end within ${String(REPLY_TIMEOUT_MS)} ms`);
            const chat = await world.owner.ok(R.getChat, { params: { chatId } });
            if (chat.working.some(({ messageId }) => messageId === reply.id)) {
                findings.add(`${where}: the finished reply ${reply.id} is still being worked on`);
            }
            const items = await entries(world, chatId);
            const start = items.findIndex(({ id }) => id === sent.id) + 1;
            const end = items.findIndex(({ id }) => id === reply.id);
            const progress = items
                .slice(start, end)
                .some((entry) => entry.type === 'message' && entry.phase === 'progress');
            const stored = items[end];
            const phase = stored?.type === 'message' ? stored.phase : undefined;
            if (phase !== (progress ? 'final' : null)) {
                findings.add(
                    `${where}: the reply's phase is ${String(phase)} after ${progress ? 'progress' : 'no progress'}`,
                );
            }
            await checkThread(world, findings, chat, items);
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.chat.activity',
        suite: SUITE,
        title: 'Threads agree with their entries: steps only on progress, working agents, linked tasks and their state',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            await send(world);
            for (const listed of await sampleThreads(world)) {
                const chat = await world.owner.ok(R.getChat, { params: { chatId: listed.id } });
                await checkThread(world, findings, chat, await entries(world, chat.id));
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.chat.retry',
        suite: SUITE,
        title: 'Retrying a thread without a recheck answers 409 nothing-to-retry and changes nothing',
        async run(ctx) {
            const world = await createWorld(ctx);
            const findings = new Findings();
            const { chatId } = await send(world);
            const where = 'POST /chats/{chatId}/retry';
            const before = await world.owner.ok(R.getChat, { params: { chatId } });
            if (before.recheck !== null) findings.add(`${where}: a reply that succeeded left a recheck`);
            const retried = await world.owner.call(R.retryChatReply, { params: { chatId } });
            if (retried.kind !== 'problem' || retried.problem.code !== 'nothing-to-retry') {
                const got = retried.kind === 'ok' ? 'ok' : retried.problem.code;
                findings.add(`${where}: without a recheck answered ${got}, not 409 nothing-to-retry`);
            }
            const after = await world.owner.ok(R.getChat, { params: { chatId } });
            if (after.messageCount !== before.messageCount || after.working.length > before.working.length) {
                findings.add(`${where}: a refused retry started a reply`);
            }
            const unknown = await world.owner.call(R.retryChatReply, { params: { chatId: UNKNOWN_CHAT_ID } });
            if (unknown.kind !== 'problem' || unknown.problem.code !== 'not-found') {
                findings.add(
                    `${where}: an unknown thread answered ${unknown.kind === 'ok' ? 'ok' : unknown.problem.code}`,
                );
            }
            return findings.outcome();
        },
    },
];
