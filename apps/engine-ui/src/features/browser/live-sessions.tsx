import { createContext, use, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type { LiveSession } from './live-session';

/**
 * The member's one live browser session in this page, kept above the routes so it outlives a navigation: the shell
 * shows it while it is live and the viewer reattaches to it. Holds the session only; the session module itself loads
 * with the first screen that opens one, so the entry stays small.
 */
export interface LiveSessions {
    readonly current: () => LiveSession | null;
    readonly subscribe: (listener: () => void) => () => void;
    /**
     * Makes `session` the current one, since the UI runs one at a time. A member's click (`end: true`) ends a different
     * previous one; a page load only closes its channel, so the engine ends it after its attach window and no load ever
     * writes. The same session shown again (StrictMode, a second read) keeps the one already running.
     */
    readonly show: (session: LiveSession, options?: { readonly end: boolean }) => void;
}

export function createLiveSessions(): LiveSessions & { readonly dispose: () => void } {
    let current: LiveSession | null = null;
    const listeners = new Set<() => void>();
    return {
        current: () => current,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        show: (session, options = { end: true }) => {
            if (session === current) return;
            if (current?.id === session.id) {
                session.dispose();
                return;
            }
            const previous = current;
            current = session;
            if (previous !== null) {
                if (options.end) void previous.end().finally(previous.dispose);
                else previous.dispose();
            }
            for (const listener of [...listeners]) listener();
        },
        dispose: () => {
            current?.dispose();
            current = null;
        },
    };
}

const LiveSessionsContext = createContext<LiveSessions | null>(null);

export function LiveSessionsProvider({ children }: { readonly children: ReactNode }) {
    const [sessions] = useState(createLiveSessions);
    useEffect(() => sessions.dispose, [sessions]);
    return <LiveSessionsContext value={sessions}>{children}</LiveSessionsContext>;
}

export function useLiveSessions(): LiveSessions {
    const sessions = use(LiveSessionsContext);
    if (sessions === null) throw new Error('useLiveSessions() needs a <LiveSessionsProvider> above it');
    return sessions;
}

export function useCurrentLiveSession(): LiveSession | null {
    const sessions = useLiveSessions();
    return useSyncExternalStore(sessions.subscribe, sessions.current);
}
