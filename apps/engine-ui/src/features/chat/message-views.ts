import type { MemberId, ReadChat, ReadChatEntry, ReadMessage, ReadParticipantRef } from '@ptbk/engine-api';

import { m } from '../../paraglide/messages';
import type { ChatSessionState } from './chat-session';

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

/** A join or a title change, shown as one quiet line between messages. */
export interface EventView {
    readonly kind: 'event';
    readonly id: string;
    readonly text: string;
}

export type ThreadView = MessageView | EventView;

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

function eventText(entry: Exclude<ReadChatEntry, ReadMessage>): string | null {
    switch (entry.type) {
        case 'joined':
            return entry.participant.kind === 'user' ? null : m.chat_event_joined({ name: entry.participant.name });
        case 'titled':
            return m.chat_event_titled({ title: entry.title });
        case 'status':
            return entry.status === 'resolved' ? m.chat_event_resolved() : null;
        // The thread's task cards (U-16) show linked tasks; until then a link is no row of its own.
        case 'linked':
            return null;
    }
}

/** The name the thread gives a participant; an agent the members list lacks keeps its key. */
export function participantName(chat: Pick<ReadChat, 'members'>, who: ReadParticipantRef): string {
    return chat.members.find((member) => member.kind === who.kind && member.key === who.key)?.name ?? who.key;
}

/**
 * The rows to show, oldest first: the thread's messages and events, with the followed reply's streamed text laid over
 * its row, and the message being sent at the end until the engine confirms it. The User joining is not shown: the
 * member's own words already say so.
 */
export function threadViews(
    chat: Pick<ReadChat, 'members' | 'questions'>,
    entries: readonly ReadChatEntry[],
    session: ChatSessionState,
    options: { readonly memberId: MemberId; readonly canSendAgain: boolean },
): ThreadView[] {
    const { reply, phase } = session;
    const questions = new Map(chat.questions.map((question) => [question.messageId as string, question]));
    const followedState: MessageState =
        phase === 'interrupted' ? 'interrupted' : phase === 'error' ? 'failed' : 'streaming';
    const views: ThreadView[] = [];
    for (const entry of entries) {
        if (entry.type !== 'message') {
            const text = eventText(entry);
            if (text !== null) views.push({ kind: 'event', id: entry.id, text });
            continue;
        }
        const followed = reply !== null && entry.id === reply.messageId;
        const question = questions.get(entry.id);
        const stored = entry.content === '' ? (session.partials.get(entry.id) ?? '') : entry.content;
        views.push({
            kind: 'message',
            id: entry.id,
            author: entry.author,
            authorName: entry.author.kind === 'user' ? '' : participantName(chat, entry.author),
            createdBy: entry.createdBy,
            // Live text while streaming; once the stream is gone, the engine's copy if it kept one.
            text: followed && (followedState === 'streaming' || entry.content === '') ? reply.text : stored,
            markdown: !followed && entry.author.kind !== 'user' && entry.status === 'completed',
            state: followed ? followedState : storedState(entry),
            retry: followed && (phase === 'interrupted' || (phase === 'error' && options.canSendAgain)),
            question: question === undefined ? null : { seen: question.seen },
            choices: question === undefined ? [] : entry.choices,
        });
    }
    if (session.outgoing !== null) {
        const unconfirmed = phase === 'unconfirmed';
        views.push({
            kind: 'message',
            id: OUTGOING_ID,
            author: { kind: 'user', key: 'user' },
            authorName: '',
            createdBy: options.memberId,
            text: session.outgoing,
            markdown: false,
            state: unconfirmed ? 'unconfirmed' : 'pending',
            retry: unconfirmed,
            question: null,
            choices: [],
        });
    }
    return views;
}
