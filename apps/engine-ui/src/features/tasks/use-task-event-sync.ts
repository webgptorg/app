import { useQueryClient } from '@tanstack/react-query';

import { useEngineEvents } from '../../app/engine-events-context';
import { taskKeys } from './tasks-keys';

/**
 * A `task.changed` hint refetches what is on screen of that task and the lists; a task's state also moves its
 * neighbours (a parent's children, a dependant's standing), so every detail is marked stale. A reconnect refetches
 * everything once, since events in the gap may be gone.
 */
export function useTaskEventSync(): void {
    const queryClient = useQueryClient();
    useEngineEvents({
        onEvent: (event) => {
            if (event.type !== 'task.changed') return;
            void queryClient.invalidateQueries({ queryKey: taskKeys.all });
        },
        onReconnect: () => {
            void queryClient.invalidateQueries({ queryKey: taskKeys.all });
        },
    });
}
