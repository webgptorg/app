import type { AgentId, TriggerId } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { agentDetailQueryOptions } from '../agents/agents-queries';

const BACK_CLASS = 'inline-flex items-center gap-1 text-sm';

function BackLabel({ children }: { readonly children: ReactNode }) {
    return (
        <>
            <ArrowLeft aria-hidden className="size-4" />
            {children}
        </>
    );
}

/** Back to the list a trigger was opened from: an agent's Triggers tab, or all triggers. */
export function TriggerListBackLink({ agentId }: { readonly agentId?: AgentId | undefined }) {
    if (agentId === undefined) {
        return (
            <Link to="/triggers" variant="standalone" className={BACK_CLASS}>
                <BackLabel>{m.trigger_back_to_list()}</BackLabel>
            </Link>
        );
    }
    return <AgentTriggersBackLink agentId={agentId} />;
}

function AgentTriggersBackLink({ agentId }: { readonly agentId: AgentId }) {
    const agent = useQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    return (
        <Link to="/agents/$agentId/triggers" params={{ agentId }} variant="standalone" className={BACK_CLASS}>
            <BackLabel>
                {agent.data === undefined
                    ? m.trigger_back_to_agent_tab()
                    : m.trigger_back_to_agent({ agent: agent.data.name })}
            </BackLabel>
        </Link>
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
        <Link
            to="/triggers/$triggerId"
            params={{ triggerId }}
            search={fromAgent ? { from: 'agent' } : {}}
            variant="standalone"
            className={BACK_CLASS}
        >
            <BackLabel>{m.trigger_back_to_trigger({ name })}</BackLabel>
        </Link>
    );
}
