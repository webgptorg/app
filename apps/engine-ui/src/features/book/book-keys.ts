import type { AgentId, RevisionId } from '@ptbk/engine-api';

/** Book queries stay apart from `agents`, so an agent event or a stream reconnect never refetches an open editor's text. */
export const bookKeys = {
    all: ['book'] as const,
    source: (agentId: AgentId) => [...bookKeys.all, 'source', agentId] as const,
    revisions: (agentId: AgentId) => [...bookKeys.all, 'revisions', agentId] as const,
    revisionPage: (agentId: AgentId, cursor: string | undefined) =>
        [...bookKeys.revisions(agentId), 'page', cursor ?? null] as const,
    revision: (agentId: AgentId, revisionId: RevisionId) =>
        [...bookKeys.revisions(agentId), 'one', revisionId] as const,
};
