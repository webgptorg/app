import type { AgentId } from '@ptbk/engine-api';
import { useToast } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { chatKeys } from './chat-keys';

/**
 * Starts a chat with its first message and opens it. Resolves `false` when either step fails, so the composer gets
 * its text back; the toast says why.
 */
export function useStartChat(agentId: AgentId): (content: string) => Promise<boolean> {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const toast = useToast();
    return async (content) => {
        const signal = AbortSignal.timeout(30_000);
        try {
            const created = await engineApi.chats.create(agentId, {}, signal);
            if (created.kind === 'ok') {
                const sent = await engineApi.chats.sendMessage(created.data.id, { content }, signal);
                if (sent.kind === 'ok') {
                    // The recent list shows the new chat without waiting for the engine's change event.
                    void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
                    // The chat page follows the reply that is now generating.
                    void navigate({
                        to: '/agents/$agentId/chat/$chatId',
                        params: { agentId, chatId: created.data.id },
                    });
                    return true;
                }
            }
        } catch {
            // Reported below, like a refusal.
        }
        toast.show({ tone: 'danger', title: m.chat_send_failed() });
        return false;
    };
}
