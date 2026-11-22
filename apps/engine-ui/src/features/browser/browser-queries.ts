import type { BrowserTabId, ChatId, EngineApiClient, RunId } from '@ptbk/engine-api';
import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { queryOptions, useQuery } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';

export const browserKeys = {
    all: ['browser'] as const,
    tabs: () => [...browserKeys.all, 'tabs'] as const,
    tabList: (filter: BrowserTabFilter) => [...browserKeys.tabs(), filter] as const,
    help: () => [...browserKeys.all, 'help'] as const,
};

export interface BrowserTabFilter {
    readonly chatId?: ChatId;
    readonly runId?: RunId;
}

/** Only `browser-tab@1` engines have these routes, and only members who may watch see anything of them. */
export const WATCH_REQUIREMENT = { capability: KNOWN_CAPABILITIES.browserTab, permission: 'browser.watch' } as const;
export const CONTROL_REQUIREMENT = {
    capability: KNOWN_CAPABILITIES.browserTab,
    permission: 'browser.control',
} as const;

/** `GET /browser-tabs`: the agents' tabs of work the member can see, newest first. Kept current by the event stream. */
export function browserTabsQueryOptions(engineApi: EngineApiClient, filter: BrowserTabFilter = {}) {
    return queryOptions({
        queryKey: browserKeys.tabList(filter),
        queryFn: async ({ signal }) => unwrap(await engineApi.browser.listTabs(filter, signal)).items,
    });
}

/** `GET /browser-help-requests?status=open`: pending and in progress, oldest first. */
export function openHelpRequestsQueryOptions(engineApi: EngineApiClient) {
    return queryOptions({
        queryKey: browserKeys.help(),
        queryFn: async ({ signal }) =>
            unwrap(await engineApi.browser.listHelpRequests({ status: 'open' }, signal)).items,
    });
}

/** The open help requests, or `undefined` while loading; nothing is asked of an engine without the capability. */
export function useOpenHelpRequests() {
    const allowed = useAllows(WATCH_REQUIREMENT);
    const query = useQuery({ ...openHelpRequestsQueryOptions(useEngineApi()), enabled: allowed });
    return allowed ? query.data : [];
}

export function useBrowserTabs(filter: BrowserTabFilter) {
    const allowed = useAllows(WATCH_REQUIREMENT);
    const query = useQuery({ ...browserTabsQueryOptions(useEngineApi(), filter), enabled: allowed });
    return allowed ? (query.data ?? []) : [];
}

export function useBrowserTab(tabId: BrowserTabId) {
    return useBrowserTabs({}).find((tab) => tab.id === tabId);
}
