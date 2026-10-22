import { useQueryClient } from '@tanstack/react-query';

import { useEngineEvents } from '../../app/engine-events-context';
import { triggerKeys } from './triggers-keys';

/**
 * Keeps trigger data current from the engine's event stream: a `trigger.changed` hint refetches that trigger, the
 * lists and the counts; `trigger.*` activity (a fire, a failure) refetches that trigger's fire history. Queries
 * nobody shows are only marked stale. A reconnect refetches everything once, since events in the gap may be gone.
 */
export function useTriggerEventSync(): void {
    const queryClient = useQueryClient();
    useEngineEvents({
        onEvent: (event) => {
            if (event.type === 'trigger.changed') {
                void queryClient.invalidateQueries({ queryKey: triggerKeys.detail(event.triggerId) });
                void queryClient.invalidateQueries({ queryKey: triggerKeys.lists() });
                void queryClient.invalidateQueries({ queryKey: triggerKeys.stats(null), exact: true });
                void queryClient.invalidateQueries({ queryKey: triggerKeys.stats(event.agentId), exact: true });
                return;
            }
            if (event.type !== 'activity' || event.activity.kind !== 'known') return;
            const activity = event.activity.activity;
            if (!activity.kind.startsWith('trigger.') || !('triggerId' in activity)) return;
            void queryClient.invalidateQueries({ queryKey: [...triggerKeys.allFires(), activity.triggerId] });
            void queryClient.invalidateQueries({ queryKey: triggerKeys.detail(activity.triggerId) });
        },
        onReconnect: () => {
            void queryClient.invalidateQueries({ queryKey: triggerKeys.all });
        },
    });
}
