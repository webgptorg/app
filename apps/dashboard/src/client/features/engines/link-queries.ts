import { queryOptions } from '@tanstack/react-query';

import { apiRoutes } from '../../../shared/api/routes';
import type { ApiClient } from '../../api/api-client';
import { dataOrThrow } from '../../api/queries';

// Here rather than in api/queries.ts, which the entry loads: only /engines/new asks for these.

/** Whether `/engines/new` may offer a link code, with the code lifetime and the install guide (D-10). */
export function linkEligibilityQuery(client: ApiClient) {
    return queryOptions({
        queryKey: ['link-eligibility'] as const,
        queryFn: async ({ signal }) => dataOrThrow(await client.call(apiRoutes.linkEligibility, {}, signal)),
    });
}

/** One link code's state, by its ID; never the code itself. */
export function linkCodeQuery(client: ApiClient, linkCodeId: string) {
    return queryOptions({
        queryKey: ['link-codes', linkCodeId] as const,
        queryFn: async ({ signal }) =>
            dataOrThrow(await client.call(apiRoutes.getLinkCode, { params: { linkCodeId } }, signal)),
    });
}
