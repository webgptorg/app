import type { MemberId, Message } from '@ptbk/engine-api';

import type { ChatSessionState } from './chat-session';

export type MessageState = 'pending' | 'streaming' | 'stopped' | 'interrupted' | 'failed' | null;

/** One row of the conversation as the panel shows it, from the cached history and the reply being followed. */
export interface MessageView {
    readonly id: string;
    readonly role: 'user' | 'agent';
    /** The member who wrote a user message; `null` for agent replies and for visitors. */
    readonly createdBy: MemberId | null;
    readonly text: string;
    /** Only a completed agent reply is rendered as markdown; everything else, including a partial reply, is text. */
    readonly markdown: boolean;
    readonly state: MessageState;
    /** The row offers Retry: a dropped stream to resume, or a failed reply to send again. */
    readonly retry: boolean;
}

function storedState(message: Message): MessageState {
    switch (message.status) {
        case 'streaming':
            return 'streaming';
        case 'cancelled':
            return 'stopped';
        case 'failed':
            return 'failed';
        case 'completed':
            return null;
    }
}

const OUTGOING_ID = 'outgoing';

/**
 * The rows to show, oldest first: the cached history with the followed reply's streamed text laid over its row (or
 * appended until the engine's copy arrives), and the message being sent at the end until the engine confirms it.
 */
export function messageViews(
    messages: readonly Message[],
    session: ChatSessionState,
    options: { readonly memberId: MemberId; readonly canSendAgain: boolean },
): MessageView[] {
    const { reply, phase } = session;
    const followedState: MessageState =
        phase === 'interrupted' ? 'interrupted' : phase === 'error' ? 'failed' : 'streaming';
    const followedView = (id: string, stored: string): MessageView => ({
        id,
        role: 'agent',
        createdBy: null,
        // Live text while streaming; once the stream is gone, the engine's copy if it kept one.
        text: followedState === 'streaming' || stored === '' ? (reply?.text ?? '') : stored,
        markdown: false,
        state: followedState,
        retry: phase === 'interrupted' || (phase === 'error' && options.canSendAgain),
    });
    const views = messages.map((message): MessageView => {
        if (message.role === 'agent' && message.id === reply?.messageId)
            return followedView(message.id, message.content);
        const text = message.content === '' ? (session.partials.get(message.id) ?? '') : message.content;
        return {
            id: message.id,
            role: message.role,
            createdBy: message.createdBy,
            text,
            markdown: message.role === 'agent' && message.status === 'completed',
            state: message.role === 'agent' ? storedState(message) : null,
            retry: false,
        };
    });
    if (reply !== null && !messages.some((message) => message.id === reply.messageId)) {
        views.push(followedView(reply.messageId, ''));
    }
    if (session.outgoing !== null) {
        views.push({
            id: OUTGOING_ID,
            role: 'user',
            createdBy: options.memberId,
            text: session.outgoing,
            markdown: false,
            state: 'pending',
            retry: false,
        });
    }
    return views;
}
