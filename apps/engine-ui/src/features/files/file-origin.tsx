import { KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';
import type { AgentId } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { useAllows, useEngineCapabilities } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { EntityChip } from '../entities/entity-chip';
import { usePermissions } from '../session/use-permissions';

/**
 * The file's agent as a chip in its colour, by name where the member may read agents (shared with the agents screens'
 * cache), else by its ID; "Engine-wide" for a file of no agent.
 */
export function FileAgent({ agentId }: { readonly agentId: AgentId | null }) {
    const allowed = useAllows({ permission: 'agents.read' });
    const agent = useQuery({
        ...agentDetailQueryOptions(useEngineApi(), agentId ?? ('' as AgentId)),
        enabled: agentId !== null && allowed,
    });
    if (agentId === null) return <span className="text-sm text-text-muted">{m.files_engine_wide()}</span>;
    return (
        <EntityChip
            kind="agent"
            id={agentId}
            name={agent.data?.name ?? agentId}
            {...(agent.data === undefined ? {} : { profile: agent.data.profile })}
        />
    );
}

/** Whether run links can lead anywhere: the engine advertises `runs@1` and the member may read runs. */
export function useRunLinks(): boolean {
    const capabilities = useEngineCapabilities();
    const { can } = usePermissions();
    return supports({ capabilities }, KNOWN_CAPABILITIES.runs) && can('runs.read');
}
