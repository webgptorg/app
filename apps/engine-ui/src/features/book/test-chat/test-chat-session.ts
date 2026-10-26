import { MAX_BOOK_SOURCE_LENGTH, MAX_TEST_CHAT_MESSAGES, MAX_TEST_CHAT_TRANSCRIPT_LENGTH } from '@ptbk/engine-api';
import type { TestChatTurn } from '@ptbk/engine-api';

/** Why the last attempt produced no (complete) reply; each has its own message in the panel. */
export type TestChatError =
    | 'invalid-book'
    | 'too-large'
    | 'limit'
    | 'forbidden'
    | 'rate-limited'
    | 'agent-deleted'
    | 'reply-failed'
    | 'dropped'
    | 'failed';

/** `stopped` and `failed` mark an agent turn that ended early; it keeps whatever text had streamed. */
export type TestTurnState = 'stopped' | 'failed' | null;

export interface TestTurn {
    readonly id: string;
    readonly role: TestChatTurn['role'];
    readonly content: string;
    readonly state: TestTurnState;
}

export type TestChatPhase = 'idle' | 'streaming' | 'error';

export interface TestChatState {
    readonly phase: TestChatPhase;
    /** The conversation shown, oldest first; only what the engine streamed and the member typed, never stored. */
    readonly turns: readonly TestTurn[];
    /** The reply streaming now. */
    readonly reply: { readonly id: string; readonly text: string } | null;
    readonly error: TestChatError | null;
    /** Replies that completed; the live region announces each one once. */
    readonly completedCount: number;
    /** For turn IDs that stay unique across resets within one panel. */
    readonly nextId: number;
}

export type TestChatAction =
    | { readonly type: 'send'; readonly content: string }
    | { readonly type: 'retry' }
    | { readonly type: 'delta'; readonly text: string }
    | { readonly type: 'completed'; readonly content: string }
    | { readonly type: 'stopped' }
    | { readonly type: 'failed'; readonly error: TestChatError }
    | { readonly type: 'refused'; readonly error: TestChatError }
    /** Refused before any request, by the client-side limits; nothing was sent, so nothing changes but the message. */
    | { readonly type: 'blocked'; readonly error: TestChatError }
    | { readonly type: 'reset' };

export const INITIAL_TEST_CHAT: TestChatState = {
    phase: 'idle',
    turns: [],
    reply: null,
    error: null,
    completedCount: 0,
    nextId: 1,
};

/**
 * What the engine gets with the next request: every turn the member saw, minus agent turns without text (a reply
 * stopped before it said anything) and failed partial replies, which a retry replaces.
 */
export function transcriptOf(turns: readonly TestTurn[]): TestChatTurn[] {
    return turns
        .filter((turn) => turn.role === 'user' || (turn.content !== '' && turn.state !== 'failed'))
        .map(({ role, content }) => ({ role, content }));
}

/** The turns a retry sends again: a failed partial reply goes, since the retry replaces it. */
export function turnsToRetry(turns: readonly TestTurn[]): readonly TestTurn[] {
    const last = turns.at(-1);
    return last?.role === 'agent' && last.state === 'failed' ? turns.slice(0, -1) : turns;
}

/** A client-side check of the contract's limits, so a refusal the engine would give never costs a request. */
export function checkTestRequest(book: string, transcript: readonly TestChatTurn[]): TestChatError | null {
    if (book.length > MAX_BOOK_SOURCE_LENGTH) return 'too-large';
    const length = transcript.reduce((total, { content }) => total + content.length, 0);
    if (transcript.length > MAX_TEST_CHAT_MESSAGES || length > MAX_TEST_CHAT_TRANSCRIPT_LENGTH) return 'limit';
    return null;
}

function endReply(state: TestChatState, turnState: TestTurnState): readonly TestTurn[] {
    if (state.reply === null) return state.turns;
    return [...state.turns, { id: state.reply.id, role: 'agent', content: state.reply.text, state: turnState }];
}

function startReply(state: TestChatState, turns: readonly TestTurn[]): TestChatState {
    return {
        ...state,
        phase: 'streaming',
        turns,
        reply: { id: `test-${String(state.nextId)}`, text: '' },
        error: null,
        nextId: state.nextId + 1,
    };
}

/** The stream drives this reducer; actions for a reply that already ended (a late delta after Stop) are ignored. */
export function testChatReducer(state: TestChatState, action: TestChatAction): TestChatState {
    switch (action.type) {
        case 'send': {
            if (state.phase === 'streaming') return state;
            const turn: TestTurn = {
                id: `test-${String(state.nextId)}`,
                role: 'user',
                content: action.content,
                state: null,
            };
            return startReply({ ...state, nextId: state.nextId + 1 }, [...state.turns, turn]);
        }
        case 'retry': {
            if (state.phase !== 'error') return state;
            return startReply(state, turnsToRetry(state.turns));
        }
        case 'delta':
            if (state.reply === null) return state;
            return { ...state, reply: { ...state.reply, text: state.reply.text + action.text } };
        case 'completed':
            if (state.reply === null) return state;
            return {
                ...state,
                phase: 'idle',
                turns: [...state.turns, { id: state.reply.id, role: 'agent', content: action.content, state: null }],
                reply: null,
                completedCount: state.completedCount + 1,
            };
        case 'stopped':
            if (state.reply === null) return state;
            return { ...state, phase: 'idle', turns: endReply(state, 'stopped'), reply: null };
        case 'failed':
            if (state.reply === null) return state;
            return { ...state, phase: 'error', turns: endReply(state, 'failed'), reply: null, error: action.error };
        case 'refused':
            return { ...state, phase: 'error', reply: null, error: action.error };
        case 'blocked':
            return state.phase === 'streaming' ? state : { ...state, error: action.error };
        case 'reset':
            return { ...INITIAL_TEST_CHAT, nextId: state.nextId };
    }
}
