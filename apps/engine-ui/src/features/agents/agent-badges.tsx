import type { AgentId, AgentRunState, AgentVisibility } from '@ptbk/engine-api';
import { Badge, Skeleton } from '@ptbk/ui';
import type { BadgeTone } from '@ptbk/ui';
import { CircleAlert, CircleDot, CircleHelp, CirclePause, Globe, Hourglass, Link2, Lock, Play } from 'lucide-react';
import type { ReactNode } from 'react';

import type { AgentLiveState as ProvidedState } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { AgentLiveState } from './agent-live-state';
import type { AgentLiveStatus } from './agent-live-state';

/** C-04's run states plus the states a registered provider reports. */
type KnownState = AgentRunState | ProvidedState;

const KNOWN_STATES: ReadonlySet<string> = new Set<KnownState>([
    'idle',
    'running',
    'stopped',
    'error',
    'working',
    'waiting',
    'failed',
]);

function isKnownState(state: string): state is KnownState {
    return KNOWN_STATES.has(state);
}

interface StateLook {
    readonly label: string;
    readonly tone: BadgeTone;
    readonly icon: ReactNode;
}

function lookOf(state: KnownState): StateLook {
    switch (state) {
        case 'idle':
            return { label: m.agent_state_idle(), tone: 'neutral', icon: <CircleDot /> };
        case 'running':
            return { label: m.agent_state_running(), tone: 'accent', icon: <Play /> };
        case 'working':
            return { label: m.agent_state_working(), tone: 'accent', icon: <Play /> };
        case 'waiting':
            return { label: m.agent_state_waiting(), tone: 'info', icon: <Hourglass /> };
        case 'stopped':
            return { label: m.agent_state_stopped(), tone: 'warning', icon: <CirclePause /> };
        case 'error':
            return { label: m.agent_state_error(), tone: 'danger', icon: <CircleAlert /> };
        case 'failed':
            return { label: m.agent_state_failed(), tone: 'danger', icon: <CircleAlert /> };
    }
}

export function stateLabel(state: KnownState): string {
    return lookOf(state).label;
}

/** A state badge with text; a state from a newer engine shows as "unknown" with its raw value. */
export function AgentStateBadge({ status }: { readonly status: AgentLiveStatus }) {
    switch (status.kind) {
        case 'pending':
            return <Skeleton shape="text" className="h-5 w-16" />;
        case 'unavailable':
            return (
                <Badge tone="neutral" icon={<CircleHelp />}>
                    {m.agent_state_unknown()}
                </Badge>
            );
        case 'state': {
            if (!isKnownState(status.state)) {
                return (
                    <Badge tone="neutral" icon={<CircleHelp />}>
                        {m.agent_state_unknown_value({ value: status.state })}
                    </Badge>
                );
            }
            const look = lookOf(status.state);
            return (
                <Badge tone={look.tone} icon={look.icon}>
                    {look.label}
                </Badge>
            );
        }
    }
}

export function AgentStatusBadge({ agentId }: { readonly agentId: AgentId }) {
    return <AgentLiveState agentId={agentId}>{(status) => <AgentStateBadge status={status} />}</AgentLiveState>;
}

export function visibilityLabel(visibility: AgentVisibility): string {
    switch (visibility) {
        case 'public':
            return m.agent_visibility_public();
        case 'unlisted':
            return m.agent_visibility_unlisted();
        case 'private':
            return m.agent_visibility_private();
    }
}

export function AgentVisibilityBadge({ visibility }: { readonly visibility: AgentVisibility }) {
    const icon = visibility === 'public' ? <Globe /> : visibility === 'unlisted' ? <Link2 /> : <Lock />;
    return (
        <Badge tone={visibility === 'public' ? 'warning' : 'neutral'} icon={icon}>
            {visibilityLabel(visibility)}
        </Badge>
    );
}
