import { AgentId, ChatId } from '@ptbk/engine-api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EngineEventsProvider } from '../../app/engine-events-context';
import type { EngineEventSubscriber } from '../../app/engine-events';
import { chatKeys } from './chat-keys';
import { useChatEventSync } from './use-chat-event-sync';

function Sync() {
    useChatEventSync();
    return null;
}

describe('useChatEventSync', () => {
    it('refreshes thread lists and the changed thread, and everything after a reconnect', () => {
        const subscribers: EngineEventSubscriber[] = [];
        const queryClient = new QueryClient();
        const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
        render(
            <QueryClientProvider client={queryClient}>
                <EngineEventsProvider
                    events={{ subscribe: (subscriber) => (subscribers.push(subscriber), () => undefined) }}
                >
                    <Sync />
                </EngineEventsProvider>
            </QueryClientProvider>,
        );
        const [subscriber] = subscribers;
        subscriber?.onEvent({ type: 'agent.changed', agentId: AgentId.parse('agent-1') });
        expect(invalidate).not.toHaveBeenCalled();
        subscriber?.onEvent({ type: 'chat.changed', chatId: ChatId.parse('Report') });
        expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
            chatKeys.lists(),
            chatKeys.detail(ChatId.parse('Report')),
        ]);
        subscriber?.onReconnect?.();
        expect(invalidate.mock.calls.slice(2).map(([filters]) => filters?.queryKey)).toEqual([
            chatKeys.lists(),
            chatKeys.details(),
        ]);
    });
});
