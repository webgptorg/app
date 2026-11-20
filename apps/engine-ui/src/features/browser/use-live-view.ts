import { useSyncExternalStore } from 'react';

import type { LiveSession, LiveView } from './live-session';

export function useLiveView(session: LiveSession): LiveView {
    return useSyncExternalStore(session.subscribe, session.getView);
}
