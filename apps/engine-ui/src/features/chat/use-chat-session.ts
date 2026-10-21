import type { ChatId, Message, MessageId } from '@ptbk/engine-api';
import { useToast } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { useEngineEvents } from '../../app/engine-events-context';
import { m } from '../../paraglide/messages';
import { mergeNewestPage, upsertMessages } from './chat-cache';
import { MESSAGE_PAGE_SIZE } from './chat-queries';
import { chatSessionReducer, INITIAL_CHAT_SESSION, isReplyActive } from './chat-session';
import type { ChatSessionState } from './chat-session';

export interface ChatSession {
    readonly state: ChatSessionState;
    /** Resolves `false` when the engine did not take the message, so the composer can give the text back. */
    readonly send: (content: string) => Promise<boolean>;
    /** Stops the reply in progress; does nothing unless one is streaming, so a second click is harmless. */
    readonly stop: () => void;
    /** After a dropped stream, resumes it where it stopped; after a failed reply, sends the message again. */
    readonly retry: () => void;
}

export interface ChatSessionOptions {
    readonly chatId: ChatId;
    /** From the chat record, which `chat.changed` events refresh; newer than the newest cached message means more. */
    readonly lastMessageAt: string | null;
    /** Oldest first, as cached. A reply still `streaming` there is followed once, e.g. after a reload. */
    readonly messages: readonly Message[];
}

/**
 * Sending, streaming, stopping and resuming a chat's replies. The stream drives the reducer; the engine's confirmed
 * messages go into the query cache as they arrive, so the history never needs a refetch.
 */
export function useChatSession({ chatId, lastMessageAt, messages }: ChatSessionOptions): ChatSession {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const toast = useToast();
    const [state, dispatch] = useReducer(chatSessionReducer, INITIAL_CHAT_SESSION);
    const stateRef = useRef(state);
    const stream = useRef<AbortController | null>(null);
    const followed = useRef(new Set<string>());
    const unmounted = useRef(new AbortController());

    useEffect(() => {
        stateRef.current = state;
    });

    useEffect(() => {
        const lifetime = new AbortController();
        unmounted.current = lifetime;
        return () => {
            lifetime.abort();
            stream.current?.abort();
        };
    }, []);

    const refreshNewest = useCallback(async () => {
        try {
            const response = await engineApi.chats.listMessages(
                chatId,
                { limit: MESSAGE_PAGE_SIZE },
                unmounted.current.signal,
            );
            if (response.kind === 'ok') mergeNewestPage(queryClient, chatId, response.data);
        } catch {
            // The history stays as it was; the next event or reconnect tries again.
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
                            upsertMessages(queryClient, chatId, [event.message]);
                            dispatch({ type: 'completed', messageId });
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

    const send = useCallback(
        async (content: string) => {
            if (isReplyActive(stateRef.current.phase)) return false;
            // A second Enter before React re-renders must not send twice.
            stateRef.current = { ...stateRef.current, phase: 'sending' };
            dispatch({ type: 'send', content });
            let refusedWith: number | undefined;
            try {
                const response = await engineApi.chats.sendMessage(chatId, { content }, unmounted.current.signal);
                if (response.kind === 'ok') {
                    upsertMessages(queryClient, chatId, [response.data.userMessage]);
                    dispatch({ type: 'sent', replyMessageId: response.data.replyMessageId });
                    void follow(response.data.replyMessageId, 0);
                    return true;
                }
                refusedWith = response.problem.status;
            } catch {
                // A network failure reads like any other: the message did not go out.
            }
            dispatch({ type: 'send-failed' });
            toast.show({
                tone: 'danger',
                title: refusedWith === 403 ? m.error_forbidden_title() : m.chat_send_failed(),
            });
            return false;
        },
        [engineApi, queryClient, chatId, follow, toast],
    );

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
                    upsertMessages(queryClient, chatId, [response.data]);
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
        if (phase === 'interrupted' && reply !== null) {
            dispatch({ type: 'resume' });
            void follow(reply.messageId, reply.lastSeq);
        } else if (phase === 'error' && lastSent !== null) {
            void send(lastSent);
        }
    }, [follow, send]);

    useEngineEvents({
        onEvent: () => undefined,
        onReconnect: () => {
            if (!isReplyActive(stateRef.current.phase)) void refreshNewest();
        },
    });

    const newest = messages.at(-1);
    useEffect(() => {
        // A reply still generating when the history loaded (a reload, another tab, a visitor's chat): follow it once.
        if (newest?.role !== 'agent' || newest.status !== 'streaming') return;
        if (followed.current.has(newest.id) || isReplyActive(stateRef.current.phase)) return;
        dispatch({ type: 'follow', messageId: newest.id });
        void follow(newest.id, 0);
    }, [newest, follow]);

    const refreshedFor = useRef<string | null>(null);
    const newestAt = newest?.createdAt;
    useEffect(() => {
        // Someone else wrote in this chat (or a visitor did): fetch the newest page once per change the engine reports.
        if (lastMessageAt === null || lastMessageAt === refreshedFor.current) return;
        if (newestAt !== undefined && Date.parse(lastMessageAt) <= Date.parse(newestAt)) return;
        if (isReplyActive(stateRef.current.phase)) return;
        refreshedFor.current = lastMessageAt;
        void refreshNewest();
    }, [lastMessageAt, newestAt, refreshNewest]);

    const replyId = state.reply?.messageId;
    const replyStatus = messages.find((message) => message.id === replyId)?.status;
    useEffect(() => {
        // The refetch after a drop shows the reply already ended: the engine's copy is the answer.
        if (state.phase === 'interrupted' && replyStatus !== undefined && replyStatus !== 'streaming') {
            dispatch({ type: 'settled' });
        }
    }, [state.phase, replyStatus]);

    return { state, send, stop, retry };
}
