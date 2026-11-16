import type { AgentRunState, AgentVisibility } from '@ptbk/engine-api';
import type { StatusTone } from '@ptbk/ui';
import { Globe, Link2, Lock } from 'lucide-react';

import { cx } from '../../app/cx';
import type { AgentLiveState as ProvidedState } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

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

export function stateLabel(state: KnownState): string {
    return LOOKS[state]().label;
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
