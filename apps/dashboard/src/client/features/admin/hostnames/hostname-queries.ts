import { queryOptions } from '@tanstack/react-query';

import { apiRoutes } from '../../../../shared/api/routes';
import type { ApiClient } from '../../../api/api-client';
import { dataOrThrow } from '../../../api/queries';

export function adminHostnamesKey(engineId: string) {
    return ['admin', 'engines', engineId, 'hostnames'] as const;
}

/** An engine's custom hostnames and the CNAME target the customer must set (D-08). */
export function adminHostnamesQuery(client: ApiClient, engineId: string) {
    return queryOptions({
        queryKey: adminHostnamesKey(engineId),
        queryFn: async ({ signal }) =>
            dataOrThrow(await client.call(apiRoutes.adminListHostnames, { params: { engineId } }, signal)),
    });
}
