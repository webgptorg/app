import type { AgentId, Diagnostic, ProblemCode, ProblemDetails, TestChatTurn } from '@ptbk/engine-api';
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { useEngineApi } from '../../../app/engine-api-context';
import { checkTestRequest, INITIAL_TEST_CHAT, testChatReducer, transcriptOf, turnsToRetry } from './test-chat-session';
import type { TestChatError, TestChatState } from './test-chat-session';

export interface TestChat {
    readonly state: TestChatState;
    /** Resolves `false` when nothing went out, so the composer gives the text back. */
    readonly send: (content: string) => Promise<boolean>;
    readonly stop: () => void;
    /** Sends the conversation again, after a refusal or a reply that did not finish. */
    readonly retry: () => void;
    /** Stops any reply and forgets the conversation. */
    readonly reset: () => void;
}

export interface TestChatOptions {
    readonly agentId: AgentId;
    /** The book as typed right now; read at send time, so every turn tests the latest draft. */
    readonly book: string;
    /** The engine refused the book: its diagnostics, for the editor's problems list. */
    readonly onInvalidBook: (diagnostics: readonly Diagnostic[]) => void;
}

const REFUSALS: Partial<Record<ProblemCode, TestChatError>> = {
    'invalid-book': 'invalid-book',
    'payload-too-large': 'too-large',
    forbidden: 'forbidden',
    'rate-limited': 'rate-limited',
    'agent-deleted': 'agent-deleted',
    'reply-failed': 'reply-failed',
};

function refusalOf(problem: ProblemDetails): TestChatError {
    return REFUSALS[problem.code] ?? 'failed';
}

/**
 * A throwaway conversation with the unsaved book: every turn sends the draft and the whole transcript, and the engine
 * stores none of it. The conversation lives in this hook's state only, so it is gone with the component.
 */
export function useTestChat({ agentId, book, onInvalidBook }: TestChatOptions): TestChat {
    const engineApi = useEngineApi();
    const [state, dispatch] = useReducer(testChatReducer, INITIAL_TEST_CHAT);
    const stateRef = useRef(state);
    const bookRef = useRef(book);
    const onInvalidBookRef = useRef(onInvalidBook);
    const stream = useRef<AbortController | null>(null);

    useEffect(() => {
        stateRef.current = state;
        bookRef.current = book;
        onInvalidBookRef.current = onInvalidBook;
    });

    useEffect(
        () => () => {
            stream.current?.abort();
        },
        [],
    );

    const run = useCallback(
        async (transcript: readonly TestChatTurn[]) => {
            stream.current?.abort();
            const controller = new AbortController();
            stream.current = controller;
            const stopped = () => controller.signal.aborted;
            try {
                const response = await engineApi.testChat.stream(
                    agentId,
                    { book: bookRef.current, messages: [...transcript] },
                    controller.signal,
                );
                if (response.kind === 'problem') {
                    if (stopped()) return;
                    if (response.problem.code === 'invalid-book') {
                        onInvalidBookRef.current(response.problem.diagnostics ?? []);
                    }
                    dispatch({ type: 'refused', error: refusalOf(response.problem) });
                    return;
                }
                for await (const { event } of response.data) {
                    if (stopped()) return;
                    switch (event.type) {
                        case 'delta':
                            dispatch({ type: 'delta', text: event.text });
                            break;
                        case 'completed':
                            dispatch({ type: 'completed', content: event.content });
                            return;
                        case 'failed':
                            dispatch({ type: 'failed', error: refusalOf(event.problem) });
                            return;
                    }
                }
                if (!stopped()) dispatch({ type: 'failed', error: 'dropped' });
            } catch {
                // Stop and Reset abort on purpose and have already settled the state.
                if (!stopped()) dispatch({ type: 'failed', error: 'dropped' });
            } finally {
                if (stream.current === controller) stream.current = null;
            }
        },
        [engineApi, agentId],
    );

    const send = useCallback(
        (content: string) => {
            const current = stateRef.current;
            if (current.phase === 'streaming') return Promise.resolve(false);
            const transcript = [...transcriptOf(current.turns), { role: 'user' as const, content }];
            const blocked = checkTestRequest(bookRef.current, transcript);
            if (blocked !== null) {
                dispatch({ type: 'blocked', error: blocked });
                return Promise.resolve(false);
            }
            // A second Enter before React re-renders must not send twice.
            stateRef.current = { ...current, phase: 'streaming' };
            dispatch({ type: 'send', content });
            void run(transcript);
            return Promise.resolve(true);
        },
        [run],
    );

    const stop = useCallback(() => {
        if (stateRef.current.phase !== 'streaming') return;
        stream.current?.abort();
        dispatch({ type: 'stopped' });
    }, []);

    const retry = useCallback(() => {
        const current = stateRef.current;
        if (current.phase !== 'error') return;
        const transcript = transcriptOf(turnsToRetry(current.turns));
        const blocked = checkTestRequest(bookRef.current, transcript);
        if (blocked !== null) {
            dispatch({ type: 'blocked', error: blocked });
            return;
        }
        stateRef.current = { ...current, phase: 'streaming' };
        dispatch({ type: 'retry' });
        void run(transcript);
    }, [run]);

    const reset = useCallback(() => {
        stream.current?.abort();
        dispatch({ type: 'reset' });
    }, []);

    return { state, send, stop, retry, reset };
}
