import { KNOWN_CAPABILITIES, supports } from '@ptbk/engine-api';
import type { AgentId, RunId } from '@ptbk/engine-api';
import { CodeText } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { useEngineCapabilities } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { usePermissions } from '../session/use-permissions';

/** An agent by name where the member may read agents (shared with the agents screens' cache), else its ID. */
export function AgentName({ agentId, link = true }: { readonly agentId: AgentId | null; readonly link?: boolean }) {
    const { can } = usePermissions();
    const agent = useQuery({
        ...agentDetailQueryOptions(useEngineApi(), agentId ?? ('' as AgentId)),
        enabled: agentId !== null && can('agents.read'),
    });
    if (agentId === null) return <span className="text-text-muted">{m.files_engine_wide()}</span>;
    const label = agent.data === undefined ? <CodeText value={agentId} /> : <span>{agent.data.name}</span>;
    if (!link) return label;
    return (
        <Link to="/agents/$agentId" params={{ agentId }} variant="standalone" className="max-w-full truncate">
            {label}
        </Link>
    );
}

/** Whether run links can lead anywhere: the engine advertises `runs@1` and the member may read runs. */
export function useRunLinks(): boolean {
    const capabilities = useEngineCapabilities();
    const { can } = usePermissions();
    return supports({ capabilities }, KNOWN_CAPABILITIES.runs) && can('runs.read');
}

export function RunLink({ runId }: { readonly runId: RunId }) {
    return (
        <Link to="/runs/$runId" params={{ runId }} variant="standalone">
            <CodeText value={runId} />
        </Link>
    );
}
