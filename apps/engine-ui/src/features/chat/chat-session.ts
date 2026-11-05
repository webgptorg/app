import type { MessageId } from '@ptbk/engine-api';

/**
 * Where the panel's send and the reply it follows stand. `sending` waits for the engine to accept the message;
 * `stopping` waits for the cancel call; `interrupted` means the stream dropped while the reply may still be
 * generating; `error` means the engine reported the reply failed; `unconfirmed` means a send got no clear answer, and
 * neither did sending it again under the same request key, so nobody knows yet whether it arrived.
 */
export type ReplyPhase =
    'idle' | 'sending' | 'unconfirmed' | 'streaming' | 'stopping' | 'done' | 'interrupted' | 'error';

export interface FollowedReply {
    readonly messageId: MessageId;
    /** The deltas so far, in order. */
    readonly text: string;
    /** The last delta's `seq`, the SSE id a resumed stream continues after. */
    readonly lastSeq: number;
}

export interface ChatSessionState {
    readonly phase: ReplyPhase;
    /** The message being sent, shown as the member's until the engine confirms it. */
    readonly outgoing: string | null;
    readonly reply: FollowedReply | null;
    /** What Retry sends again after a failed reply. */
    readonly lastSent: string | null;
    /** Text streamed for replies that ended without the engine keeping it (a stopped reply may come back empty). */
    readonly partials: ReadonlyMap<string, string>;
    /** Replies that completed while this panel followed them; the live region announces each one once. */
    readonly completedCount: number;
}

export type ChatSessionAction =
    | { readonly type: 'send'; readonly content: string }
    | { readonly type: 'send-failed' }
    | { readonly type: 'send-unconfirmed' }
    | { readonly type: 'send-recheck' }
    | { readonly type: 'send-arrived' }
    | { readonly type: 'sent' }
    | { readonly type: 'follow'; readonly messageId: MessageId }
    | { readonly type: 'resume' }
    | { readonly type: 'delta'; readonly messageId: MessageId; readonly seq: number; readonly text: string }
    | { readonly type: 'completed'; readonly messageId: MessageId }
    | { readonly type: 'failed'; readonly messageId: MessageId; readonly cancelled: boolean }
    | { readonly type: 'stop' }
    | { readonly type: 'stopped' }
    | { readonly type: 'cancel-failed' }
    | { readonly type: 'dropped'; readonly messageId: MessageId }
    | { readonly type: 'settled' };

export const INITIAL_CHAT_SESSION: ChatSessionState = {
    phase: 'idle',
    outgoing: null,
    reply: null,
    lastSent: null,
    partials: new Map(),
    completedCount: 0,
};

/** A reply is under way: the composer waits, and events for the chat do not refresh what the stream will deliver. */
export function isReplyActive(phase: ReplyPhase): boolean {
    return phase === 'sending' || phase === 'unconfirmed' || phase === 'streaming' || phase === 'stopping';
}

function keepPartial(state: ChatSessionState): ReadonlyMap<string, string> {
    if (state.reply === null || state.reply.text === '') return state.partials;
    return new Map(state.partials).set(state.reply.messageId, state.reply.text);
}

const isFollowed = (state: ChatSessionState, messageId: MessageId): boolean => state.reply?.messageId === messageId;

/** Stream events drive this reducer; nothing polls. Events for a reply the panel no longer follows are ignored. */
export function chatSessionReducer(state: ChatSessionState, action: ChatSessionAction): ChatSessionState {
    switch (action.type) {
        case 'send':
            return isReplyActive(state.phase)
                ? state
                : { ...state, phase: 'sending', outgoing: action.content, reply: null, lastSent: action.content };
        case 'send-failed':
        case 'send-arrived':
            return { ...state, phase: 'idle', outgoing: null };
        case 'send-unconfirmed':
            return state.phase === 'sending' ? { ...state, phase: 'unconfirmed' } : state;
        case 'send-recheck':
            return state.phase === 'unconfirmed' ? { ...state, phase: 'sending' } : state;
        case 'sent':
            // Replies are entries of their own, from whichever agent answers; the panel follows them as they appear.
            return { ...state, phase: 'idle', outgoing: null };
        case 'follow':
            return isReplyActive(state.phase)
                ? state
                : { ...state, phase: 'streaming', reply: { messageId: action.messageId, text: '', lastSeq: 0 } };
        case 'resume':
            return state.phase === 'interrupted' ? { ...state, phase: 'streaming' } : state;
        case 'delta': {
            const reply = state.reply;
            // A resumed stream may repeat what was already shown; `seq` tells.
            if (reply === null || !isFollowed(state, action.messageId) || action.seq <= reply.lastSeq) return state;
            return { ...state, reply: { ...reply, text: reply.text + action.text, lastSeq: action.seq } };
        }
        case 'completed':
            if (!isFollowed(state, action.messageId)) return state;
            return { ...state, phase: 'done', reply: null, completedCount: state.completedCount + 1 };
        case 'failed':
            if (!isFollowed(state, action.messageId)) return state;
            return action.cancelled
                ? { ...state, phase: 'done', partials: keepPartial(state), reply: null }
                : { ...state, phase: 'error', partials: keepPartial(state) };
        case 'stop':
            return state.phase === 'streaming' ? { ...state, phase: 'stopping' } : state;
        case 'stopped':
            return state.phase === 'stopping'
                ? { ...state, phase: 'done', partials: keepPartial(state), reply: null }
                : state;
        case 'cancel-failed':
            // The engine may still be generating; Retry resumes the stream to find out.
            return state.phase === 'stopping' ? { ...state, phase: 'interrupted' } : state;
        case 'dropped':
            if (!isFollowed(state, action.messageId) || state.phase !== 'streaming') return state;
            return { ...state, phase: 'interrupted' };
        case 'settled':
            return state.phase === 'interrupted'
                ? { ...state, phase: 'done', partials: keepPartial(state), reply: null }
                : state;
    }
}
