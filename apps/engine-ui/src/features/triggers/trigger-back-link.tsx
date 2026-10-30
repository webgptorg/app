import type { AgentId, TriggerId } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { BackLink } from '../shell/page';

/** Back to the list a trigger was opened from: an agent's Triggers tab, or all triggers. */
export function TriggerListBackLink({ agentId }: { readonly agentId?: AgentId | undefined }) {
    if (agentId === undefined) return <BackLink to="/triggers">{m.trigger_back_to_list()}</BackLink>;
    return <AgentTriggersBackLink agentId={agentId} />;
}

function AgentTriggersBackLink({ agentId }: { readonly agentId: AgentId }) {
    const agent = useQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    return (
        <BackLink to="/agents/$agentId/triggers" params={{ agentId }}>
            {agent.data === undefined
                ? m.trigger_back_to_agent_tab()
                : m.trigger_back_to_agent({ agent: agent.data.name })}
        </BackLink>
    );
}

/** Back from a trigger's form to the trigger, keeping where it was opened from. */
export function TriggerBackLink({
    triggerId,
    name,
    fromAgent,
}: {
    readonly triggerId: TriggerId;
    readonly name: string;
    readonly fromAgent: boolean;
}) {
    return (
        <BackLink to="/triggers/$triggerId" params={{ triggerId }} search={fromAgent ? { from: 'agent' } : {}}>
            {m.trigger_back_to_trigger({ name })}
        </BackLink>
    );
}
