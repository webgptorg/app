import { useQueryClient } from '@tanstack/react-query';

import { useEngineEvents } from '../../app/engine-events-context';
import { agentKeys } from '../agents/agents-keys';
import { updateCachedRun } from './run-cache';
import { runKeys } from './runs-keys';

/**
 * Keeps run data current from the engine's event stream: a `run.changed` hint writes the new status into every cached
 * copy of the run at once, then refetches what is on screen of that run, the lists and the counts. Queries nobody shows
 * are only marked stale, so the detail page fetches its run and no list. A reconnect refetches everything once,
 * since events in the gap may be gone. `activity` events belong to the home feed (U-08).
 */
export function useRunEventSync(): void {
    const queryClient = useQueryClient();
    useEngineEvents({
        onEvent: (event) => {
            if (event.type !== 'run.changed') return;
            updateCachedRun(queryClient, event.runId, (run) => ({ ...run, status: event.status }));
            void queryClient.invalidateQueries({ queryKey: runKeys.detail(event.runId) });
            void queryClient.invalidateQueries({ queryKey: runKeys.lists() });
            void queryClient.invalidateQueries({ queryKey: runKeys.stats(null), exact: true });
            void queryClient.invalidateQueries({ queryKey: runKeys.stats(event.agentId), exact: true });
            void queryClient.invalidateQueries({ queryKey: agentKeys.latestRun(event.agentId) });
        },
        onReconnect: () => {
            void queryClient.invalidateQueries({ queryKey: runKeys.all });
        },
    });
}
