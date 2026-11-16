import type { SemVer } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { homeKeys } from './home-keys';

export interface UpdateNotice {
    readonly version: SemVer;
}

/** An `engine.update-available` seen on the event stream; there is nothing to fetch, the event sync writes it. */
export function updateNoticeQueryOptions() {
    return queryOptions({
        queryKey: homeKeys.updateNotice(),
        queryFn: (): UpdateNotice | null => null,
        staleTime: Number.POSITIVE_INFINITY,
    });
}
