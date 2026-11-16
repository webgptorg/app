import type { AgentId, AgentRunState, AgentVisibility } from '@ptbk/engine-api';
import { Skeleton, StatusPill } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import { Globe, Link2, Lock } from 'lucide-react';

import { cx } from '../../app/cx';
import type { AgentLiveState as ProvidedState } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { AgentLiveState } from './agent-live-state';
import type { AgentLiveStatus } from './agent-live-state';

/** C-04's run states plus the states a registered provider reports. */
type KnownState = AgentRunState | ProvidedState;

interface StateLook {
    readonly label: string;
    readonly tone: StatusTone;
}

const LOOKS: Readonly<Record<KnownState, () => StateLook>> = {
    idle: () => ({ label: m.agent_state_idle(), tone: 'neutral' }),
    running: () => ({ label: m.agent_state_running(), tone: 'live' }),
    working: () => ({ label: m.agent_state_working(), tone: 'live' }),
    waiting: () => ({ label: m.agent_state_waiting(), tone: 'waiting' }),
    // Stopped by someone: it takes no work until asked again, which an owner should notice.
    stopped: () => ({ label: m.agent_state_stopped(), tone: 'warning' }),
    error: () => ({ label: m.agent_state_error(), tone: 'danger' }),
    failed: () => ({ label: m.agent_state_failed(), tone: 'danger' }),
};

function isKnownState(state: string): state is KnownState {
    return Object.hasOwn(LOOKS, state);
}

export function stateLabel(state: KnownState): string {
    return LOOKS[state]().label;
}

/** A state as a pill with words; a state from a newer engine shows as "unknown" with its raw value. */
export function AgentStateBadge({
    status,
    variant = 'soft',
}: {
    readonly status: AgentLiveStatus;
    readonly variant?: 'soft' | 'quiet';
}) {
    switch (status.kind) {
        case 'pending':
            return <Skeleton shape="text" className="h-5 w-16" />;
        case 'unavailable':
            return (
                <StatusPill tone="neutral" variant={variant}>
                    {m.agent_state_unknown()}
                </StatusPill>
            );
        case 'state': {
            if (!isKnownState(status.state)) {
                return (
                    <StatusPill tone="neutral" variant={variant}>
                        {m.agent_state_unknown_value({ value: status.state })}
                    </StatusPill>
                );
            }
            const look = LOOKS[status.state]();
            return (
                <StatusPill tone={look.tone} variant={variant}>
                    {look.label}
                </StatusPill>
            );
        }
    }
}

export function AgentStatusBadge({
    agentId,
    variant,
}: {
    readonly agentId: AgentId;
    readonly variant?: 'soft' | 'quiet';
}) {
    return (
        <AgentLiveState agentId={agentId}>
            {(status) => <AgentStateBadge status={status} {...(variant === undefined ? {} : { variant })} />}
        </AgentLiveState>
    );
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

export function VisibilityIcon({
    visibility,
    className,
}: {
    readonly visibility: AgentVisibility;
    readonly className?: string;
}) {
    const Icon = visibility === 'public' ? Globe : visibility === 'unlisted' ? Link2 : Lock;
    return <Icon aria-hidden className={cx('size-3.5 shrink-0', className)} />;
}

/**
 * Who may use the agent, as quiet words with an icon: a fact, not a state. Public is the one worth noticing (anyone
 * with the link can chat without signing in), so it alone keeps the text colour.
 */
export function AgentVisibilityBadge({ visibility }: { readonly visibility: AgentVisibility }) {
    return (
        <span
            className={cx(
                'inline-flex items-center gap-1.5 text-xs whitespace-nowrap',
                visibility === 'public' ? 'font-medium text-text' : 'text-text-muted',
            )}
        >
            <VisibilityIcon visibility={visibility} />
            {visibilityLabel(visibility)}
        </span>
    );
}
