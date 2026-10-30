import type { AgentId } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import type {
    AgentStopControl,
    AgentStopTarget,
    AgentLiveState as ProvidedState,
    FeatureDefinition,
} from '../../app/registry/feature';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import { usePermissions } from '../session/use-permissions';
import { agentStatusQueryOptions } from './agents-queries';
import { useAgentMutations } from './use-agent-mutations';

/** What the UI knows about an agent's state right now; `state` may be a value this UI does not know yet. */
export type AgentLiveStatus =
    | { readonly kind: 'pending' }
    | { readonly kind: 'state'; readonly state: string }
    | { readonly kind: 'unavailable' };

type StatusProvider = NonNullable<FeatureDefinition['agentStatusProvider']>;

interface RegisteredProvider {
    readonly featureId: string;
    readonly provider: StatusProvider;
}

/** The first visible feature that derives agent state (U-09 from runs); without one, the draft status endpoint. */
function useStatusProvider(): RegisteredProvider | undefined {
    for (const feature of useVisibleFeatures()) {
        if (feature.agentStatusProvider !== undefined) {
            return { featureId: feature.id, provider: feature.agentStatusProvider };
        }
    }
    return undefined;
}

export interface AgentLiveStateProps {
    readonly agentId: AgentId;
    readonly children: (status: AgentLiveStatus) => ReactNode;
}

/**
 * Resolves the agent's live state from the registered `agentStatusProvider`, or from C-04's draft `GET /status`
 * kept current by `agent.status` events. A component rather than a hook: the provider's hook is called from a child
 * keyed by its feature, so the rules of hooks hold even if capabilities change while the page is open.
 */
export function AgentLiveState({ agentId, children }: AgentLiveStateProps) {
    const registered = useStatusProvider();
    if (registered === undefined) return <FallbackState agentId={agentId}>{children}</FallbackState>;
    return (
        <ProvidedLiveState key={registered.featureId} provider={registered.provider} agentId={agentId}>
            {children}
        </ProvidedLiveState>
    );
}

function ProvidedLiveState({
    provider,
    agentId,
    children,
}: AgentLiveStateProps & { readonly provider: StatusProvider }) {
    const state: ProvidedState | null = provider.useAgentLiveState(agentId);
    return children(state === null ? { kind: 'pending' } : { kind: 'state', state });
}

function FallbackState({ agentId, children }: AgentLiveStateProps) {
    const status = useQuery(agentStatusQueryOptions(useEngineApi(), agentId));
    if (status.data !== undefined) return children({ kind: 'state', state: status.data.state });
    return children(status.isError ? { kind: 'unavailable' } : { kind: 'pending' });
}

export interface AgentStopProps {
    readonly agent: AgentStopTarget;
    /** `null` when the member may not stop this agent. */
    readonly children: (control: AgentStopControl | null) => ReactNode;
}

/**
 * Stopping the agent, from the same source as its state: the provider's stop, or C-04's draft `POST /stop` while the
 * draft status says `running`. There is deliberately no start: agents work on demand (chat, email, schedule).
 */
export function AgentStop({ agent, children }: AgentStopProps) {
    const registered = useStatusProvider();
    if (registered === undefined) return <FallbackStop agent={agent}>{children}</FallbackStop>;
    return (
        <ProvidedStop key={registered.featureId} provider={registered.provider} agent={agent}>
            {children}
        </ProvidedStop>
    );
}

function ProvidedStop({ provider, agent, children }: AgentStopProps & { readonly provider: StatusProvider }) {
    return children(provider.useAgentStop(agent));
}

function FallbackStop({ agent, children }: AgentStopProps) {
    const allowed = usePermissions().can('agents.run');
    const status = useQuery(agentStatusQueryOptions(useEngineApi(), agent.id));
    const { stop } = useAgentMutations();
    if (!allowed) return children(null);
    return children({
        state: status.data?.state === 'running' ? 'stoppable' : 'none',
        isPending: stop.isPending,
        stop: () => {
            if (!stop.isPending) stop.mutate(agent);
        },
    });
}
