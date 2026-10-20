import type { EngineApiClient } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { agentsKeys } from './agents-keys';
import type { AgentListParams } from './agents-keys';

export function agentListQueryOptions(engineApi: EngineApiClient, params: AgentListParams) {
    return queryOptions({
        queryKey: agentsKeys.list(params),
        queryFn: async ({ signal }) => unwrap(await engineApi.agents.list(params, signal)),
    });
}
