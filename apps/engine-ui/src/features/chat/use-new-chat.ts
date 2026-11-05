import type { AgentId } from '@ptbk/engine-api';
import { useToast } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { chatKeys } from './chat-keys';
import { isRefusal, newRequestKey, refusalTitle } from './send-delivery';

const START_TIMEOUT_MS = 30_000;

export interface NewChat {
    /** Opens a new thread with Chatter, or with the agent given, and goes to it. */
    readonly start: (agentId?: AgentId) => void;
    readonly starting: boolean;
}

/**
 * Starts a thread. A start without a clear answer goes again under the same request key, so a retry opens the thread
 * the first try created instead of a second, empty one.
 */
export function useNewChat(): NewChat {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const toast = useToast();
    const [starting, setStarting] = useState(false);
    const unclear = useRef<{ readonly agentId: AgentId | undefined; readonly requestKey: string } | null>(null);

    const start = (agentId?: AgentId) => {
        if (starting) return;
        const requestKey =
            unclear.current !== null && unclear.current.agentId === agentId
                ? unclear.current.requestKey
                : newRequestKey();
        setStarting(true);
        void (async () => {
            try {
                const created = await engineApi.chats.create(
                    { requestKey, ...(agentId === undefined ? {} : { agentId }) },
                    AbortSignal.timeout(START_TIMEOUT_MS),
                );
                if (created.kind === 'ok') {
                    unclear.current = null;
                    queryClient.setQueryData(chatKeys.detail(created.data.id), created.data);
                    void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
                    void navigate({ to: '/chats/$chatId', params: { chatId: created.data.id } });
                    return;
                }
                const refused = isRefusal(created.problem);
                // A 5xx may come after the engine created the thread: the next try reuses the key.
                unclear.current = refused ? null : { agentId, requestKey };
                let title: string = m.chat_start_failed();
                if (created.problem.code === 'chatter-missing') title = m.chat_chatter_missing();
                else if (refused) title = refusalTitle(created.problem);
                toast.show({ tone: 'danger', title });
            } catch {
                unclear.current = { agentId, requestKey };
                toast.show({ tone: 'danger', title: m.chat_start_failed() });
            } finally {
                setStarting(false);
            }
        })();
    };

    return { start, starting };
}
