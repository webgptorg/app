import type { ReadBrowserHelpRequest } from '@ptbk/engine-api';
import { lazy, Suspense } from 'react';

import { useAllows } from '../../app/registry/use-visible-features';
import { WATCH_REQUIREMENT } from './browser-queries';
import type { BrowserTabFilter } from './browser-queries';

const LinkedBrowserTabs = lazy(() =>
    import('./linked-browser-tabs').then((module) => ({ default: module.LinkedBrowserTabs })),
);
const HelpRequestItems = lazy(() =>
    import('./help-request-item').then((module) => ({ default: module.HelpRequestItems })),
);

/**
 * Where the run and chat pages show the agent's tabs. The browser code loads only on an engine with `browser-tab@1`,
 * so a page of an engine without it carries none of it.
 */
export function BrowserTabsSlot(props: { readonly filter: BrowserTabFilter; readonly className?: string }) {
    if (!useAllows(WATCH_REQUIREMENT)) return null;
    return (
        <Suspense fallback={null}>
            <LinkedBrowserTabs {...props} />
        </Suspense>
    );
}

/** Home's help request items, as list items; nothing loads while there are none. */
export function HelpRequestsSlot({ requests }: { readonly requests: readonly ReadBrowserHelpRequest[] }) {
    if (requests.length === 0) return null;
    return (
        <Suspense fallback={null}>
            <HelpRequestItems requests={requests} />
        </Suspense>
    );
}
