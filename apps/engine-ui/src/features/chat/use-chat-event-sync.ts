import { useQueryClient } from '@tanstack/react-query';

import { useEngineEvents } from '../../app/engine-events-context';
import { chatKeys } from './chat-keys';

/**
 * Keeps chat lists and chat records current from the engine's event stream while chat screens are open. An open
 * chat's history is not refetched here: its panel compares the refreshed record with what it holds and fetches only
 * the newest page when something is missing.
 */
export function useChatEventSync(): void {
    const queryClient = useQueryClient();
    useEngineEvents({
        onEvent: (event) => {
            if (event.type !== 'chat.changed') return;
            void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
            void queryClient.invalidateQueries({ queryKey: chatKeys.detail(event.chatId) });
        },
        onReconnect: () => {
            void queryClient.invalidateQueries({ queryKey: chatKeys.lists() });
            void queryClient.invalidateQueries({ queryKey: chatKeys.details() });
        },
    });
}
