import { AgentId } from '@ptbk/engine-api';
import { notFound } from '@tanstack/react-router';

import { classifyApiError } from '../../app/api-errors';
import type { RouterContext } from '../../app/router-context';
import { agentDetailQueryOptions } from './agents-queries';

/** Loads the agent for its page; an ID that cannot exist, a 404 and a deleted agent all read as "agent not found". */
export async function loadAgentDetail(context: RouterContext, rawAgentId: string): Promise<void> {
    const agentId = AgentId.safeParse(rawAgentId).data;
    if (agentId === undefined) {
        notFound({ throw: true });
        return;
    }
    try {
        const agent = await context.queryClient.query({
            ...agentDetailQueryOptions(context.engineApi, agentId),
            staleTime: 'static',
        });
        if (agent.deletedAt !== null) notFound({ throw: true });
    } catch (error) {
        const failure = classifyApiError(error);
        if (failure.kind === 'problem' && failure.problem.status === 404) notFound({ throw: true });
        throw error;
    }
}
