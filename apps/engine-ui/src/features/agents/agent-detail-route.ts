import { AgentId } from '@ptbk/engine-api';
import { getRouteApi } from '@tanstack/react-router';

const route = getRouteApi('/agents/$agentId');

/** The agent ID from the URL; the detail route's loader has already refused one that does not parse. */
export function useAgentIdParam(): AgentId {
    return AgentId.parse(route.useParams({ select: (params) => params.agentId }));
}
