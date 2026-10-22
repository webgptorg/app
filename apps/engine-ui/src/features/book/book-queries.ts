import type { AgentId, EngineApiClient, RevisionId } from '@ptbk/engine-api';
import { queryOptions } from '@tanstack/react-query';

import { unwrap } from '../../app/api-errors';
import { bookKeys } from './book-keys';

/** The history panel's page size; a book rarely has more versions than fit on two pages. */
export const REVISION_PAGE_SIZE = 20;

export function agentSourceQueryOptions(engineApi: EngineApiClient, agentId: AgentId) {
    return queryOptions({
        queryKey: bookKeys.source(agentId),
        queryFn: async ({ signal }) => unwrap(await engineApi.agents.getSource(agentId, signal)),
        // The editor works on the text it opened with; a save refreshes it, nothing else should.
        staleTime: Number.POSITIVE_INFINITY,
    });
}

export function revisionPageQueryOptions(engineApi: EngineApiClient, agentId: AgentId, cursor: string | undefined) {
    return queryOptions({
        queryKey: bookKeys.revisionPage(agentId, cursor),
        queryFn: async ({ signal }) =>
            unwrap(
                await engineApi.agents.listRevisions(
                    agentId,
                    { limit: REVISION_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
                    signal,
                ),
            ),
    });
}

/** A revision never changes once written. */
export function revisionQueryOptions(engineApi: EngineApiClient, agentId: AgentId, revisionId: RevisionId) {
    return queryOptions({
        queryKey: bookKeys.revision(agentId, revisionId),
        queryFn: async ({ signal }) => unwrap(await engineApi.agents.getRevision(agentId, revisionId, signal)),
        staleTime: Number.POSITIVE_INFINITY,
    });
}
