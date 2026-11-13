import type {
    MemberId,
    ReadChat,
    ReadChatEntry,
    ReadMessage,
    ReadParticipant,
    ReadParticipantRef,
    ReadReplyStep,
} from '@ptbk/engine-api';

import { m } from '../../paraglide/messages';
import type { ChatSessionState } from './chat-session';
import { flattenedProgress, parseFlattenedSteps } from './progress-fallback';

export type MessageState = 'pending' | 'unconfirmed' | 'streaming' | 'stopped' | 'interrupted' | 'failed' | null;

/** One message of the thread as the panel shows it, from the cached entries and the reply being followed. */
export interface MessageView {
    readonly kind: 'message';
    readonly id: string;
    readonly author: ReadParticipantRef;
    /** The agent's name as the thread knows it; empty for the User, whose rows name the member instead. */
    readonly authorName: string;
    /** The member who wrote a User message; `null` for agents. */
    readonly createdBy: MemberId | null;
    /** `null` while the engine has not saved it yet. */
    readonly createdAt: string | null;
    readonly text: string;
    /** Only a completed agent message is rendered as markdown; everything else, a partial reply too, is plain text. */
    readonly markdown: boolean;
    readonly state: MessageState;
    /** The row offers Retry: a dropped stream to resume, a failed reply to send again, a send to check on again. */
    readonly retry: boolean;
    /** An outstanding question to the User, and whether anyone has seen it yet. */
    readonly question: { readonly seen: boolean } | null;
    /** Answers the agent offers; shown only while the question waits. */
    readonly choices: readonly string[];
}

/**
 * `live`: the agent works on it now. `done`: its reply ended the turn, so the steps fold into one line above it.
 * `unfinished`: the agent stopped working without a reply.
 */
export type StepsStatus = 'live' | 'done' | 'unfinished';

/** What an agent did during one turn, from its `progress` messages and, while it works, its `working` entry. */
export interface StepsView {
    readonly kind: 'steps';
    /** Stays the same from live to done, so the card folds instead of being replaced. */
    readonly id: string;
    readonly author: ReadParticipantRef;
    readonly authorName: string;
    readonly createdBy: null;
    readonly createdAt: string;
    readonly status: StepsStatus;
    readonly steps: readonly ReadReplyStep[];
    readonly startedAt: string;
    /** The reply that ended the turn, or the last step of an unfinished one; `null` while live. */
    readonly endedAt: string | null;
}

/** Where a task came into the thread; its state is the thread's live copy, `null` if the engine no longer lists it. */
export interface TaskView {
    readonly kind: 'task';
    readonly id: string;
    readonly createdAt: string;
    readonly name: string;
    readonly task: ReadChat['tasks'][number] | null;
    /** The agent on it, as the thread names it; `null` when the task has none or the thread does not know it. */
    readonly agent: ReadParticipant | null;
}

/** A join or a title change, shown as one quiet line between messages. */
export interface EventView {
    readonly kind: 'event';
    readonly id: string;
    readonly createdAt: string;
    readonly text: string;
}

/** The first row of a calendar day in the reader's zone. */
export interface DayView {
    readonly kind: 'day';
    readonly id: string;
    readonly at: string;
}

/** The member's message is in, and no agent has started on it: the row escalates from "starting" to an error. */
export interface WaitingView {
    readonly kind: 'waiting';
    readonly id: string;
    readonly agent: ReadParticipantRef;
    readonly agentName: string;
    /** When the message that waits was saved. */
    readonly since: string;
}

/** A failed reply the engine attempts again by itself at `nextAt`. */
export interface RecheckView {
    readonly kind: 'recheck';
    readonly id: string;
    readonly agent: ReadParticipantRef | null;
    readonly agentName: string | null;
    readonly cause: string;
    readonly nextAt: string;
    readonly rounds: number;
}

export type ThreadView = MessageView | StepsView | TaskView | EventView | DayView | WaitingView | RecheckView;

function storedState(message: ReadMessage): MessageState {
    switch (message.status) {
        case 'streaming':
            return 'streaming';
        case 'cancelled':
            return 'stopped';
        case 'failed':
            return 'failed';
        // `unknown` is a status a newer engine added: the message shows as it is, with no label this UI cannot explain.
        case 'completed':
        case 'unknown':
            return null;
    }
}

const OUTGOING_ID = 'outgoing';
const MAX_STEP_TEXT = 500;

function eventText(entry: Exclude<ReadChatEntry, ReadMessage>): string | null {
    switch (entry.type) {
        case 'joined':
            return entry.participant.kind === 'user' ? null : m.chat_event_joined({ name: entry.participant.name });
        case 'titled':
            return m.chat_event_titled({ title: entry.title });
        case 'status':
            return entry.status === 'resolved' ? m.chat_event_resolved() : null;
        case 'linked':
            return null;
    }
}

/** The name the thread gives a participant; an agent the members list lacks keeps its key. */
export function participantName(chat: Pick<ReadChat, 'members'>, who: ReadParticipantRef): string {
    return chat.members.find((member) => member.kind === who.kind && member.key === who.key)?.name ?? who.key;
}

const keyOf = (who: ReadParticipantRef): string => `${who.kind}:${who.key}`;

/**
 * The agent a member's message goes to: the one it opens by addressing (`+@Name` or `@Name`, the longest name that
 * fits), else the thread's main agent, its first.
 */
export function addressedAgent(members: readonly ReadParticipant[], content: string): ReadParticipant | undefined {
    const agents = members.filter((member) => member.kind === 'agent');
    const addressed = /^\+?@/.exec(content.trimStart());
    if (addressed !== null) {
        const rest = content.trimStart().slice(addressed[0].length);
        const named = agents
            .filter((agent) => rest.startsWith(agent.name) && !/[\p{L}\p{N}_]/u.test(rest.charAt(agent.name.length)))
            .sort((a, b) => b.name.length - a.name.length)[0];
        if (named !== undefined) return named;
    }
    return agents[0];
}

/**
 * A progress message's steps. One without steps (a partial engine) still says what its text says, through the
 * flattened reading if it fits, else as one note.
 */
function progressSteps(message: ReadMessage, next: ReadMessage | undefined): readonly ReadReplyStep[] | null {
    if (message.author.kind !== 'agent') return null;
    if (message.phase === 'progress') {
        if (message.steps.length > 0) return message.steps;
        const text = message.content.trim();
        if (text === '') return [];
        return (
            parseFlattenedSteps(text) ?? [
                { kind: 'note', tool: null, text: text.slice(0, MAX_STEP_TEXT), level: 'info' },
            ]
        );
    }
    return flattenedProgress(message, next);
}

interface Run {
    readonly author: ReadParticipantRef;
    readonly firstId: string;
    readonly startedAt: string;
    lastAt: string;
    readonly steps: ReadReplyStep[];
    /** Where its first progress message stood, for a run that never got a reply. */
    readonly slot: number;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of a moment in the given zone. */
export function calendarDay(at: string, timeZone: string): string {
    let format = dayFormats.get(timeZone);
    if (format === undefined) {
        format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
        if (dayFormats.size < 16) dayFormats.set(timeZone, format);
    }
    return format.format(new Date(at));
}

function withDays(views: readonly ThreadView[], timeZone: string): ThreadView[] {
    const out: ThreadView[] = [];
    let day: string | null = null;
    for (const view of views) {
        const at = 'createdAt' in view ? view.createdAt : null;
        if (at !== null) {
            const next = calendarDay(at, timeZone);
            if (next !== day) out.push({ kind: 'day', id: `day:${next}`, at });
            day = next;
        }
        out.push(view);
    }
    return out;
}

export interface ThreadViewOptions {
    readonly memberId: MemberId;
    readonly canSendAgain: boolean;
    /** The reader's zone, which decides where one day ends. */
    readonly timeZone: string;
}

/**
 * The rows to show, oldest first: the thread's messages and events, each agent's turn with its steps folded above the
 * reply that ended it, a live card for each agent at work, task cards where tasks came in, a day divider at each new
 * day, and at the end what the thread waits for and the message being sent until the engine confirms it. The User
 * joining is not shown: the member's own words already say so.
 */
export function threadViews(
    chat: Pick<ReadChat, 'members' | 'questions' | 'working' | 'tasks' | 'recheck'>,
    entries: readonly ReadChatEntry[],
    session: ChatSessionState,
    options: ThreadViewOptions,
): ThreadView[] {
    const { reply, phase } = session;
    const questions = new Map(chat.questions.map((question) => [question.messageId as string, question]));
    const followedState: MessageState =
        phase === 'interrupted' ? 'interrupted' : phase === 'error' ? 'failed' : 'streaming';
    const messages = entries.filter((entry): entry is ReadMessage => entry.type === 'message');
    const nextOf = new Map(messages.map((message, index) => [message.id as string, messages[index + 1]]));
    const working = new Map(chat.working.map((entry) => [keyOf(entry.author), entry]));
    const runs = new Map<string, Run>();
    const nameOf = (who: ReadParticipantRef) => participantName(chat, who);

    const live = (entry: ReadChat['working'][number], run: Run | undefined): StepsView => ({
        kind: 'steps',
        id: run === undefined ? `working:${keyOf(entry.author)}` : `steps:${run.firstId}`,
        author: entry.author,
        authorName: nameOf(entry.author),
        createdBy: null,
        createdAt: entry.startedAt,
        status: 'live',
        steps: entry.steps.length > 0 ? entry.steps : (run?.steps ?? []),
        startedAt: entry.startedAt,
        endedAt: null,
    });
    const settled = (run: Run, status: 'done' | 'unfinished', endedAt: string): StepsView => ({
        kind: 'steps',
        id: `steps:${run.firstId}`,
        author: run.author,
        authorName: nameOf(run.author),
        createdBy: null,
        createdAt: run.startedAt,
        status,
        steps: run.steps,
        startedAt: run.startedAt,
        endedAt,
    });

    const views: ThreadView[] = [];
    for (const entry of entries) {
        if (entry.type === 'linked') {
            const task = chat.tasks.find((candidate) => candidate.name === entry.task) ?? null;
            const agentId = task?.agentId ?? null;
            views.push({
                kind: 'task',
                id: entry.id,
                createdAt: entry.createdAt,
                name: entry.task,
                task,
                agent:
                    chat.members.find((member) => member.kind === 'agent' && member.key === (agentId as string)) ??
                    null,
            });
            continue;
        }
        if (entry.type !== 'message') {
            const text = eventText(entry);
            if (text !== null) views.push({ kind: 'event', id: entry.id, createdAt: entry.createdAt, text });
            continue;
        }
        const author = keyOf(entry.author);
        const steps = progressSteps(entry, nextOf.get(entry.id));
        if (steps !== null) {
            const run = runs.get(author);
            if (run === undefined) {
                runs.set(author, {
                    author: entry.author,
                    firstId: entry.id,
                    startedAt: entry.createdAt,
                    lastAt: entry.createdAt,
                    steps: [...steps],
                    slot: views.length,
                });
            } else {
                run.steps.push(...steps);
                run.lastAt = entry.createdAt;
            }
            continue;
        }
        const run = runs.get(author);
        const writing = working.get(author);
        if (writing !== undefined && writing.messageId === entry.id) {
            views.push(live(writing, run));
            working.delete(author);
            runs.delete(author);
        } else if (run !== undefined) {
            views.push(settled(run, 'done', entry.createdAt));
            runs.delete(author);
        }

        const followed = reply !== null && entry.id === reply.messageId;
        const question = questions.get(entry.id);
        const stored = entry.content === '' ? (session.partials.get(entry.id) ?? '') : entry.content;
        views.push({
            kind: 'message',
            id: entry.id,
            author: entry.author,
            authorName: entry.author.kind === 'user' ? '' : nameOf(entry.author),
            createdBy: entry.createdBy,
            createdAt: entry.createdAt,
            // Live text while streaming; once the stream is gone, the engine's copy if it kept one.
            text: followed && (followedState === 'streaming' || entry.content === '') ? reply.text : stored,
            markdown: !followed && entry.author.kind !== 'user' && entry.status === 'completed',
            state: followed ? followedState : storedState(entry),
            retry: followed && (phase === 'interrupted' || (phase === 'error' && options.canSendAgain)),
            question: question === undefined ? null : { seen: question.seen },
            choices: question === undefined ? [] : entry.choices,
        });
    }

    // An agent at work whose reply has no message yet: its card goes last, its steps so far folded into it.
    const tail: ThreadView[] = [];
    for (const [author, entry] of working) {
        tail.push(live(entry, runs.get(author)));
        runs.delete(author);
    }
    const unfinished = [...runs.values()].sort((a, b) => b.slot - a.slot);
    for (const run of unfinished) views.splice(run.slot, 0, settled(run, 'unfinished', run.lastAt));

    const waiting = waitingFor(chat, messages, session);
    if (chat.recheck !== null) {
        const agent = waiting?.agent ?? chat.members.find((member) => member.kind === 'agent');
        tail.push({
            kind: 'recheck',
            id: 'recheck',
            agent: agent === undefined ? null : { kind: agent.kind, key: agent.key },
            agentName: agent === undefined ? null : nameOf(agent),
            cause: chat.recheck.cause,
            nextAt: chat.recheck.nextAt,
            rounds: chat.recheck.rounds,
        });
    } else if (waiting !== null && chat.working.length === 0) {
        tail.push(waiting);
    }

    const all = withDays(views, options.timeZone);
    all.push(...tail);
    if (session.outgoing !== null) {
        const unconfirmed = phase === 'unconfirmed';
        all.push({
            kind: 'message',
            id: OUTGOING_ID,
            author: { kind: 'user', key: 'user' },
            authorName: '',
            createdBy: options.memberId,
            createdAt: null,
            text: session.outgoing,
            markdown: false,
            state: unconfirmed ? 'unconfirmed' : 'pending',
            retry: unconfirmed,
            question: null,
            choices: [],
        });
    }
    return all;
}

/**
 * The member's last message, when nothing has answered it: no agent message after it, none streaming, nobody at work.
 * A message still being sent is not waiting on an agent yet.
 */
function waitingFor(
    chat: Pick<ReadChat, 'members'>,
    messages: readonly ReadMessage[],
    session: ChatSessionState,
): WaitingView | null {
    if (session.outgoing !== null) return null;
    const last = messages.at(-1);
    if (last?.author.kind !== 'user' || last.status !== 'completed') return null;
    const agent = addressedAgent(chat.members, last.content);
    if (agent === undefined) return null;
    return {
        kind: 'waiting',
        id: 'waiting',
        agent: { kind: agent.kind, key: agent.key },
        agentName: agent.name,
        since: last.createdAt,
    };
}
