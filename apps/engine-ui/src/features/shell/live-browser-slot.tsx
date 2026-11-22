import { lazy, Suspense } from 'react';

import { useCurrentLiveSession } from '../browser/live-sessions';

const LiveBrowserBar = lazy(() =>
    import('../browser/live-browser-bar').then((module) => ({ default: module.LiveBrowserBar })),
);

/** Renders nothing, and loads nothing, until the member has a live browser session in this page. */
export function LiveBrowserSlot() {
    const session = useCurrentLiveSession();
    if (session === null) return null;
    return (
        <Suspense fallback={null}>
            <LiveBrowserBar session={session} />
        </Suspense>
    );
}
