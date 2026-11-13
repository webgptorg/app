import { EngineApiContractError } from '@ptbk/engine-api';
import type { ChatId, MessageId, ReadChatEntry, ReadMessage } from '@ptbk/engine-api';
import { useToast } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { useEngineEvents } from '../../app/engine-events-context';
import { m } from '../../paraglide/messages';
import { mergeNewestPage, upsertEntries } from './chat-cache';
import { chatKeys } from './chat-keys';
import { ENTRY_PAGE_SIZE } from './chat-queries';
import { chatSessionReducer, INITIAL_CHAT_SESSION, isReplyActive } from './chat-session';
import type { ChatSessionState } from './chat-session';
import { isRefusal, newRequestKey, refusalTitle } from './send-delivery';

/**
 * What Retry on a reply achieved: `nothing` when the engine had no failed reply to attempt (the agent has not started
 * on it yet, or already answered); `unavailable` when this engine has no retry route.
 */
export type RetryOutcome = 'retried' | 'nothing' | 'unavailable' | 'failed';

export interface ChatSession {
    readonly state: ChatSessionState;
    /**
     * Sends as the User; `replyTo` names the question it answers. Resolves `false` when the engine did not take the
     * message, so the composer can give the text back.
     */
    readonly send: (content: string, replyTo?: MessageId) => Promise<boolean>;
    /** Stops the reply in progress; does nothing unless one is streaming, so a second click is harmless. */
    readonly stop: () => void;
    /**
     * After a dropped stream, resumes it where it stopped; after a failed reply, sends the message again; after a send
     * nobody could confirm, sends it again under the same request key, which cannot save it twice.
     */
    readonly retry: () => void;
    /**
     * Asks the engine to attempt the thread's failed reply now (`POST /retry`), then refreshes the thread. It never
     * sends the member's message again: that is saved, and a new request key would save it twice.
     */
    readonly retryReply: () => Promise<RetryOutcome>;
}

export interface ChatSessionOptions {
    readonly chatId: ChatId;
    /** From the thread record, which `chat.changed` events refresh; a newer one means entries this panel lacks. */
    readonly updatedAt: string;
    /** Oldest first, as cached. A message still `streaming` there is followed, e.g. an agent answering. */
    readonly entries: readonly ReadChatEntry[];
}

interface PendingSend {
    readonly content: string;
    readonly requestKey: string;
    readonly replyTo: MessageId | undefined;
}

const isMessage = (entry: ReadChatEntry): entry is ReadMessage => entry.type === 'message';

/**
 * Sending, streaming, stopping and resuming in one thread. Replies are entries of their own, from whichever agent
 * answers, so the panel follows the newest message still streaming; the engine's confirmed entries go into the query
 * cache as they arrive.
 */
export function useChatSession({ chatId, updatedAt, entries }: ChatSessionOptions): ChatSession {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const toast = useToast();
    const [state, dispatch] = useReducer(chatSessionReducer, INITIAL_CHAT_SESSION);
    const stateRef = useRef(state);
    const stream = useRef<AbortController | null>(null);
    const followed = useRef(new Set<string>());
    const unmounted = useRef(new AbortController());
    const sendAgain = useRef<(() => void) | null>(null);

    useEffect(() => {
        stateRef.current = state;
    });

    useEffect(() => {
        const lifetime = new AbortController();
        unmounted.current = lifetime;
        const followedIds = followed.current;
        return () => {
            lifetime.abort();
            stream.current?.abort();
            // An effect re-run (StrictMode, Activity) has to open the stream this just closed.
            followedIds.clear();
            // The cache never goes stale by itself and holds no final text for the reply being followed.
            const { phase, reply } = stateRef.current;
            if (isReplyActive(phase) || reply !== null) {
                void queryClient.invalidateQueries({ queryKey: chatKeys.entries(chatId), refetchType: 'none' });
            }
        };
    }, [queryClient, chatId]);

    const refreshNewest = useCallback(async () => {
        try {
            const response = await engineApi.chats.listEntries(
                chatId,
                { limit: ENTRY_PAGE_SIZE },
                unmounted.current.signal,
            );
            if (response.kind === 'ok') mergeNewestPage(queryClient, chatId, response.data);
        } catch {
            // The thread stays as it was; the next event or reconnect tries again.
        }
    }, [engineApi, queryClient, chatId]);

    const follow = useCallback(
        async (messageId: MessageId, lastSeq: number) => {
            followed.current.add(messageId);
            stream.current?.abort();
            const controller = new AbortController();
            stream.current = controller;
            const dropped = () => {
                if (controller.signal.aborted) return;
                dispatch({ type: 'dropped', messageId });
                void refreshNewest();
            };
            try {
                const response = await engineApi.chats.streamReply(
                    chatId,
                    messageId,
                    lastSeq > 0 ? { lastEventId: String(lastSeq) } : {},
                    controller.signal,
                );
                if (response.kind === 'problem') {
                    dropped();
                    return;
                }
                for await (const { event } of response.data) {
                    switch (event.type) {
                        case 'delta':
                            dispatch({ type: 'delta', messageId, seq: event.seq, text: event.text });
                            break;
                        case 'completed':
                            upsertEntries(queryClient, chatId, [event.message]);
                            dispatch({ type: 'completed', messageId });
                            // A question, a status or another agent may follow the reply.
                            void refreshNewest();
                            return;
                        case 'failed':
                            // A stop in progress settles through its own cancel call.
                            if (controller.signal.aborted) return;
                            dispatch({ type: 'failed', messageId, cancelled: event.problem.code === 'cancelled' });
                            void refreshNewest();
                            return;
                    }
                }
                dropped();
            } catch {
                dropped();
            }
        },
        [engineApi, queryClient, chatId, refreshNewest],
    );

    /**
     * One attempt under the send's request key. `null` when nobody knows whether it arrived (no answer, or a 5xx that
     * may come after the engine saved it); repeating the key answers the original message, never a second one.
     */
    const attempt = useCallback(
        async ({ content, requestKey, replyTo }: PendingSend): Promise<boolean | null> => {
            try {
                const response = await engineApi.chats.sendMessage(
                    chatId,
                    { content, requestKey, ...(replyTo === undefined ? {} : { replyTo }) },
                    unmounted.current.signal,
                );
                if (response.kind === 'ok') {
                    upsertEntries(queryClient, chatId, [response.data.message]);
                    dispatch({ type: 'sent' });
                    // The answer to it arrives as entries of its own.
                    void refreshNewest();
                    return true;
                }
                if (isRefusal(response.problem)) {
                    dispatch({ type: 'send-failed' });
                    toast.show({ tone: 'danger', title: refusalTitle(response.problem) });
                    return false;
                }
            } catch {
                // No answer says nothing about the message, like the 5xx above.
            }
            return null;
        },
        [engineApi, queryClient, chatId, toast, refreshNewest],
    );

    const send = useCallback(
        async (content: string, replyTo?: MessageId) => {
            if (isReplyActive(stateRef.current.phase)) return false;
            // A second Enter before React re-renders must not send twice.
            stateRef.current = { ...stateRef.current, phase: 'sending' };
            dispatch({ type: 'send', content });
            const pending: PendingSend = { content, requestKey: newRequestKey(), replyTo };
            const { signal } = unmounted.current;
            let outcome = await attempt(pending);
            while (outcome === null && !signal.aborted) {
                dispatch({ type: 'send-unconfirmed' });
                await new Promise<void>((resolve) => {
                    sendAgain.current = resolve;
                    signal.addEventListener('abort', () => {
                        resolve();
                    });
                });
                outcome = await attempt(pending);
            }
            return outcome === true;
        },
        [attempt],
    );

    const recheckSend = useCallback(() => {
        if (sendAgain.current === null) return;
        dispatch({ type: 'send-recheck' });
        const wake = sendAgain.current;
        sendAgain.current = null;
        wake();
    }, []);

    const stop = useCallback(() => {
        const { phase, reply } = stateRef.current;
        if (phase !== 'streaming' || reply === null) return;
        stateRef.current = { ...stateRef.current, phase: 'stopping' };
        dispatch({ type: 'stop' });
        stream.current?.abort();
        void (async () => {
            try {
                const response = await engineApi.chats.cancelReply(chatId, reply.messageId, unmounted.current.signal);
                if (response.kind === 'ok') {
                    upsertEntries(queryClient, chatId, [response.data]);
                    dispatch({ type: 'stopped' });
                    return;
                }
                if (response.problem.code === 'reply-finished') {
                    await refreshNewest();
                    dispatch({ type: 'stopped' });
                    return;
                }
            } catch {
                // Reported below, like a refusal.
            }
            dispatch({ type: 'cancel-failed' });
            toast.show({ tone: 'danger', title: m.error_mutation_failed() });
        })();
    }, [engineApi, queryClient, chatId, refreshNewest, toast]);

    const retry = useCallback(() => {
        const { phase, reply, lastSent } = stateRef.current;
        if (phase === 'unconfirmed') {
            recheckSend();
        } else if (phase === 'interrupted' && reply !== null) {
            dispatch({ type: 'resume' });
            void follow(reply.messageId, reply.lastSeq);
        } else if (phase === 'error' && lastSent !== null) {
            void send(lastSent);
        }
    }, [follow, send, recheckSend]);

    const retryReply = useCallback(async (): Promise<RetryOutcome> => {
        let outcome: RetryOutcome = 'failed';
        try {
            const response = await engineApi.chats.retry(chatId, unmounted.current.signal);
            if (response.kind === 'ok') {
                queryClient.setQueryData(chatKeys.detail(chatId), response.data);
                outcome = 'retried';
            } else if (response.problem.code === 'nothing-to-retry') {
                outcome = 'nothing';
            } else if (response.problem.status === 404) {
                outcome = 'unavailable';
            }
        } catch (error) {
            // An engine that predates the route may answer with anything (an HTML 404, a 405): not a failure to report.
            if (error instanceof EngineApiContractError) outcome = 'unavailable';
        }
        if (outcome === 'failed' && !unmounted.current.signal.aborted) {
            toast.show({ tone: 'danger', title: m.error_mutation_failed() });
        }
        // Nothing waiting to retry means the attempt already ran or the reply came after all: check what is there now.
        await Promise.all([queryClient.invalidateQueries({ queryKey: chatKeys.detail(chatId) }), refreshNewest()]);
        return outcome;
    }, [engineApi, queryClient, chatId, toast, refreshNewest]);

    useEngineEvents({
        onEvent: () => undefined,
        onReconnect: () => {
            if (stateRef.current.phase === 'unconfirmed') recheckSend();
            else if (!isReplyActive(stateRef.current.phase)) void refreshNewest();
        },
    });

    const streaming = entries.findLast(
        (entry): entry is ReadMessage =>
            isMessage(entry) && entry.status === 'streaming' && entry.author.kind !== 'user',
    );
    useEffect(() => {
        // An agent is writing (the answer to this panel's send, another agent joining in, a reload mid-reply): follow
        // it once. A newer one takes over from an older one.
        if (streaming === undefined || followed.current.has(streaming.id)) return;
        const { phase } = stateRef.current;
        if (phase === 'sending' || phase === 'unconfirmed' || phase === 'stopping') return;
        dispatch({ type: 'follow', messageId: streaming.id });
        void follow(streaming.id, 0);
    }, [streaming, follow]);

    const refreshedFor = useRef(updatedAt);
    useEffect(() => {
        // Someone else wrote, an agent joined or the title changed: fetch the newest page once per change reported.
        if (updatedAt === refreshedFor.current) return;
        refreshedFor.current = updatedAt;
        void refreshNewest();
    }, [updatedAt, refreshNewest]);

    const replyId = state.reply?.messageId;
    const followedEntry = entries.find((entry): entry is ReadMessage => isMessage(entry) && entry.id === replyId);
    const settledStatus = followedEntry?.status;
    useEffect(() => {
        // The refetch after a drop shows the reply already ended: the engine's copy is the answer.
        if (state.phase === 'interrupted' && settledStatus !== undefined && settledStatus !== 'streaming') {
            dispatch({ type: 'settled' });
        }
    }, [state.phase, settledStatus]);

    return { state, send, stop, retry, retryReply };
}
