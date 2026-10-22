import { useQueryClient } from '@tanstack/react-query';

import { useEngineEvents } from '../../app/engine-events-context';
import { integrationKeys } from './integrations-keys';

/**
 * Keeps integration data current from the engine's event stream: an `integration.changed` hint or `integration.*`
 * activity refetches what is on screen of that integration, the lists and the counts; queries nobody shows are only
 * marked stale. Activity of a kind this UI does not know names no integration, so it refreshes every activity list. A
 * reconnect refetches everything once, since events in the gap may be gone.
 */
export function useIntegrationEventSync(): void {
    const queryClient = useQueryClient();
    const refresh = (integrationId: string | null) => {
        void queryClient.invalidateQueries({ queryKey: integrationKeys.lists() });
        void queryClient.invalidateQueries({ queryKey: integrationKeys.allStats() });
        if (integrationId === null) {
            void queryClient.invalidateQueries({ queryKey: integrationKeys.activities() });
            return;
        }
        void queryClient.invalidateQueries({ queryKey: integrationKeys.detail(integrationId) });
        void queryClient.invalidateQueries({ queryKey: integrationKeys.activity(integrationId) });
    };
    useEngineEvents({
        onEvent: (event) => {
            if (event.type === 'integration.changed') {
                refresh(event.integrationId);
                return;
            }
            if (event.type !== 'activity') return;
            const item = event.activity;
            if (item.kind === 'known') {
                if ('integrationId' in item.activity) refresh(item.activity.integrationId);
                return;
            }
            if (item.base.kind.startsWith('integration.')) refresh(null);
        },
        onReconnect: () => {
            void queryClient.invalidateQueries({ queryKey: integrationKeys.all });
        },
    });
}
