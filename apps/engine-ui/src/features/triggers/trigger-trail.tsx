import type { AgentId, ReadTrigger, TriggerId } from '@ptbk/engine-api';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';
import { Crumb } from '../shell/page';

/**
 * Where a trigger's pages sit, outermost first: its agent's Triggers tab when it was opened from there, else all
 * triggers. The trail is the way back, so it keeps that origin.
 */
export function triggerTrail(
    agent: { readonly agentId: AgentId; readonly agentName: string | null } | undefined,
): ReactNode[] {
    if (agent === undefined) return [<TriggersCrumb key="triggers" />];
    const params = { agentId: agent.agentId };
    return [
        <Crumb key="agent" to="/agents/$agentId" params={params}>
            {agent.agentName ?? agent.agentId}
        </Crumb>,
        <Crumb key="triggers" to="/agents/$agentId/triggers" params={params}>
            {m.agent_tab_triggers()}
        </Crumb>,
    ];
}

export function TriggersCrumb() {
    return <Crumb to="/triggers">{m.triggers_title()}</Crumb>;
}

/** The trigger itself, above its form. */
export function TriggerCrumb({
    trigger,
    fromAgent,
}: {
    readonly trigger: Pick<ReadTrigger, 'name'> & { readonly id: TriggerId };
    readonly fromAgent: boolean;
}) {
    return (
        <Crumb to="/triggers/$triggerId" params={{ triggerId: trigger.id }} search={fromAgent ? { from: 'agent' } : {}}>
            {trigger.name}
        </Crumb>
    );
}
