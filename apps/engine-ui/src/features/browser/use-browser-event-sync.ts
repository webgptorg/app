import { useQueryClient } from '@tanstack/react-query';

import { useEngineEvents } from '../../app/engine-events-context';
import { browserKeys } from './browser-queries';

/**
 * Tabs and help requests change with what agents do, so the lists refetch on the engine's hints (IDs only). The live
 * session itself hears its tab's changes over its own channel.
 */
export function useBrowserEventSync(): void {
    const queryClient = useQueryClient();
    useEngineEvents({
        onEvent: (event) => {
            if (event.type === 'browser-tab.changed') {
                void queryClient.invalidateQueries({ queryKey: browserKeys.tabs() });
            } else if (event.type === 'browser-help.changed') {
                void queryClient.invalidateQueries({ queryKey: browserKeys.help() });
                // A tab carries its open request's ID, which a help change may have set or cleared.
                void queryClient.invalidateQueries({ queryKey: browserKeys.tabs() });
            }
        },
        onReconnect: () => {
            void queryClient.invalidateQueries({ queryKey: browserKeys.all });
        },
    });
}
