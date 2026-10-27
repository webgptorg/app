import { createInMemoryEngineApiClient } from '@ptbk/engine-api/in-memory';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { TEST_NOW } from '../../../testing/test-engine-api';
import type { FeedPageParam } from './activity-feed-cache';
import { activityFeedQueryOptions } from './activity-queries';

describe('the activity feed query', () => {
    it('asks for a cursor page, a page before a time, and one area', async () => {
        const engineApi = createInMemoryEngineApiClient({ clock: { now: () => TEST_NOW } });
        const activity = { ...engineApi.activity };
        const list = vi.spyOn(activity, 'list');
        const client = { ...engineApi, activity };
        const queryClient = new QueryClient();
        const fetchPage = (pageParam: FeedPageParam, area: 'run' | null) =>
            activityFeedQueryOptions(client, area).queryFn?.({
                pageParam,
                signal: AbortSignal.timeout(1000),
                queryKey: ['activity', 'feed', area],
                meta: undefined,
                client: queryClient,
                // eslint-disable-next-line @typescript-eslint/no-deprecated -- still required by the context type
                direction: 'forward',
            });

        await fetchPage(null, 'run');
        expect(list).toHaveBeenLastCalledWith({ limit: 20, kind: 'run.' }, expect.anything());
        await fetchPage({ before: '2026-10-01T11:00:00.000Z' }, null);
        expect(list).toHaveBeenLastCalledWith({ limit: 20, to: '2026-10-01T11:00:00.000Z' }, expect.anything());
    });
});
