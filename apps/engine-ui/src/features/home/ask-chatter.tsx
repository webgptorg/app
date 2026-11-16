import type { ChatId } from '@ptbk/engine-api';
import { useToast } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { chatKeys } from '../chat/chat-keys';
import { Composer } from '../chat/composer';
import { isRefusal, newRequestKey, refusalTitle } from '../chat/send-delivery';

const START_TIMEOUT_MS = 30_000;

interface Attempt {
    readonly content: string;
    readonly chatKey: string;
    readonly messageKey: string;
    /** The thread the first try created, so a retry sends into it instead of opening a second one. */
    readonly chatId: ChatId | null;
}

/**
 * Starts a chat with Chatter, sends the member's words as its first message and goes into the thread, where the reply
 * streams. A try without a clear answer goes again under the same request keys, so it can open neither a second
 * thread nor a second copy of the message.
 */
function useAskChatter(): { readonly ask: (content: string) => Promise<boolean>; readonly asking: boolean } {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const toast = useToast();
    const [asking, setAsking] = useState(false);
    const unclear = useRef<Attempt | null>(null);

    const ask = async (content: string): Promise<boolean> => {
        const previous = unclear.current?.content === content ? unclear.current : null;
        let attempt: Attempt = previous ?? {
            content,
            chatKey: newRequestKey(),
            messageKey: newRequestKey(),
            chatId: null,
        };
        setAsking(true);
        try {
            let chatId = attempt.chatId;
            if (chatId === null) {
                const created = await engineApi.chats.create(
                    { requestKey: attempt.chatKey },
                    AbortSignal.timeout(START_TIMEOUT_MS),
                );
                if (created.kind !== 'ok') {
                    unclear.current = isRefusal(created.problem) ? null : attempt;
                    toast.show({
                        tone: 'danger',
                        title:
                            created.problem.code === 'chatter-missing'
                                ? m.chat_chatter_missing()
                                : isRefusal(created.problem)
                                  ? refusalTitle(created.problem)
                                  : m.chat_start_failed(),
                    });
                    return false;
                }
                chatId = created.data.id;
                queryClient.setQueryData(chatKeys.detail(chatId), created.data);
                attempt = { ...attempt, chatId };
            }
            const sent = await engineApi.chats.sendMessage(
                chatId,
                { content, requestKey: attempt.messageKey },
                AbortSignal.timeout(START_TIMEOUT_MS),
            );
            void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
            if (sent.kind !== 'ok') {
                unclear.current = isRefusal(sent.problem) ? { ...attempt, messageKey: newRequestKey() } : attempt;
                toast.show({ tone: 'danger', title: refusalTitle(sent.problem) });
                return false;
            }
            unclear.current = null;
            void navigate({ to: '/chats/$chatId', params: { chatId } });
            return true;
        } catch {
            unclear.current = attempt;
            toast.show({ tone: 'danger', title: m.chat_send_failed() });
            return false;
        } finally {
            setAsking(false);
        }
    };

    return { ask, asking };
}

/** Home's first move: ask Chatter anything, in the same composer the chat uses. */
export function AskChatter() {
    const { ask, asking } = useAskChatter();
    return (
        <Composer
            label={m.home_ask_label()}
            labelHidden
            placeholder={m.home_ask_placeholder()}
            busy={asking}
            onSend={ask}
            className="w-full"
        />
    );
}
