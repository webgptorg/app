import type { AgentId, ChatId } from '@ptbk/engine-api';
import { useToast } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { useCurrentMember } from '../session/use-current-member';
import { chatKeys } from './chat-keys';
import { checkDelivery, isRefusal, refusalTitle } from './send-delivery';

const START_TIMEOUT_MS = 30_000;

export interface StartChat {
    /**
     * Starts a chat with its first message and opens it. Resolves `false` when that did not happen, so the composer
     * keeps its text; the toast or `unconfirmed` says why.
     */
    readonly start: (content: string) => Promise<boolean>;
    /** A first message got no clear answer and neither did the check for it: sending again could send it twice. */
    readonly unconfirmed: boolean;
    readonly checkAgain: () => void;
}

interface UnclearStart {
    readonly chatId: ChatId;
    readonly content: string;
}

export function useStartChat(agentId: AgentId): StartChat {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const toast = useToast();
    const { memberId } = useCurrentMember();
    const [unclear, setUnclear] = useState<UnclearStart | null>(null);
    // A retry goes into the chat the failed attempt created, so failures leave no trail of empty chats.
    const started = useRef<{ readonly agentId: AgentId; readonly chatId: ChatId } | null>(null);

    const failed = (title: string = m.chat_send_failed()) => {
        toast.show({ tone: 'danger', title });
        return false;
    };

    const open = (chatId: ChatId) => {
        started.current = null;
        // The recent list shows the new chat without waiting for the engine's change event.
        void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
        // The chat page follows the reply that is now generating.
        void navigate({ to: '/agents/$agentId/chat/$chatId', params: { agentId, chatId } });
        return true;
    };

    const settle = async ({ chatId, content }: UnclearStart) => {
        const check = await checkDelivery(
            engineApi,
            chatId,
            { content, memberId, knownIds: new Set() },
            AbortSignal.timeout(START_TIMEOUT_MS),
        );
        setUnclear(check.kind === 'unknown' ? { chatId, content } : null);
        if (check.kind === 'unknown') return false;
        return check.kind === 'arrived' ? open(chatId) : failed();
    };

    const start = async (content: string) => {
        const signal = AbortSignal.timeout(START_TIMEOUT_MS);
        let chatId = started.current?.agentId === agentId ? started.current.chatId : null;
        try {
            if (chatId === null) {
                const created = await engineApi.chats.create(agentId, {}, signal);
                if (created.kind !== 'ok') return failed(refusalTitle(created.problem));
                chatId = created.data.id;
                started.current = { agentId, chatId };
            }
            const sent = await engineApi.chats.sendMessage(chatId, { content }, signal);
            if (sent.kind === 'ok') return open(chatId);
            if (isRefusal(sent.problem)) return failed(refusalTitle(sent.problem));
        } catch {
            // Without a chat no message went out; with one, no answer says nothing about the message.
            if (chatId === null) return failed();
        }
        return settle({ chatId, content });
    };

    return {
        start,
        unconfirmed: unclear !== null,
        checkAgain: () => {
            if (unclear !== null) void settle(unclear);
        },
    };
}
