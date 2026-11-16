import type { ReadAgent } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { agentListQueryOptions } from '../agents/agents-queries';

const NO_AGENTS: readonly ReadAgent[] = [];
// The first page of agents fills the agent filter and the chips' colours; a trigger of another agent still shows.
const AGENT_LIMIT = 100;

/**
 * The engine's first page of agents, for the agent filter and picker and the chips' faces and colours: one cached
 * query. A member without `agents.read` gets none (`allowed: false`) and is never sent to ask the engine.
 */
export function useTriggerAgents(enabled = true): {
    readonly allowed: boolean;
    readonly list: readonly ReadAgent[];
    readonly byId: ReadonlyMap<string, ReadAgent>;
} {
    const allowed = useAllows({ permission: 'agents.read' });
    const query = useQuery({
        ...agentListQueryOptions(useEngineApi(), { limit: AGENT_LIMIT, sort: 'name' }),
        enabled: enabled && allowed,
    });
    const list = query.data?.items ?? NO_AGENTS;
    const byId = useMemo(() => new Map(list.map((agent) => [agent.id, agent])), [list]);
    return { allowed, list, byId };
}
