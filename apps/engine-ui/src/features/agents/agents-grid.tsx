import type { Agent } from '@ptbk/engine-api';
import { EmptyState, Section, Skeleton, tintStyle, viewTransitionStyle } from '@ptbk/ui';
import { Bot } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { agentColor } from '../chat/references/agent-color';
import { isWorking, NO_ACTIVITY } from './agent-activity';
import type { AgentActivity } from './agent-activity';
import { AgentAvatar } from './agent-avatar';
import { AgentStatusLine } from './agent-status';

const SKELETON_CARDS = 6;

interface CardProps {
    readonly agent: Agent;
    readonly activity: AgentActivity;
    /**
     * Whether this card carries the View Transition names: only the card that opens or closes the panel, and only
     * while the panel is not open (then the panel holds them). Named cards would each paint as their own layer above
     * the backdrop for the length of the transition.
     */
    readonly named: boolean;
    readonly onOpen: (agent: Agent) => void;
}

/**
 * One agent as a card: its picture large, its name, its role on one line and a light status line with how long it has
 * worked or when it was last active. Hover lifts it and deepens its tint; the character breathes while it works or
 * blinks once when idle (motion only where it is allowed, in agents-grid.css). Clicking opens the agent's panel, which
 * morphs out of the card.
 */
function AgentCard({ agent, activity, named, onOpen }: CardProps) {
    const tint = agentColor(agent.profile.color, agent.id);
    const working = isWorking(activity);
    const detailsId = useId();
    return (
        <li className="flex min-w-0">
            {/* Named by the agent alone; its state and role are read after the name, not run into it. */}
            <button
                type="button"
                aria-haspopup="dialog"
                aria-label={agent.name}
                aria-describedby={detailsId}
                data-agent-card={agent.id}
                onClick={() => {
                    onOpen(agent);
                }}
                style={{ ...tintStyle(tint), ...(named ? viewTransitionStyle('agent-card', agent.id) : {}) }}
                className={cx(
                    'agent-card group flex w-full min-w-0 cursor-pointer flex-col items-start gap-3 rounded-surface border border-hairline p-4 text-left',
                    'bg-[color-mix(in_oklab,var(--tint)_4%,var(--color-surface))] hover:bg-[color-mix(in_oklab,var(--tint)_9%,var(--color-surface))]',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    'motion-safe:transition-[background-color,translate,box-shadow] motion-safe:duration-(--motion-state) motion-safe:ease-out',
                    'motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-overlay',
                )}
            >
                <span
                    className="agent-card-art flex"
                    data-working={working ? '' : undefined}
                    style={named ? viewTransitionStyle('agent-art', agent.id) : undefined}
                >
                    <AgentAvatar
                        name={agent.name}
                        agentKey={agent.id}
                        profile={agent.profile}
                        origin={agent.origin}
                        size="xl"
                    />
                </span>
                <span className="flex w-full min-w-0 flex-col gap-0.5">
                    {/* Names and roles come from Books: React renders them as text. */}
                    <span className="truncate text-sm font-semibold">{agent.name}</span>
                    <span id={detailsId} className="flex min-w-0 flex-col gap-1.5">
                        <span className="truncate text-xs text-text-muted">{agent.profile.description}</span>
                        <AgentStatusLine agentId={agent.id} activity={activity} withTime />
                    </span>
                </span>
            </button>
        </li>
    );
}

function CardGrid({ children, label }: { readonly children: ReactNode; readonly label: string }) {
    return (
        <ul
            aria-label={label}
            className="grid grid-cols-1 gap-3 min-[30rem]:grid-cols-2 md:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]"
        >
            {children}
        </ul>
    );
}

export interface AgentsGridProps {
    readonly own: readonly Agent[];
    readonly builtIn: readonly Agent[];
    readonly showOwn: boolean;
    readonly loading: boolean;
    readonly activity: ReadonlyMap<string, AgentActivity>;
    readonly openId: string | null;
    /** The card the panel last morphed out of or into, which alone carries the transition's names. */
    readonly morphId: string | null;
    readonly onOpen: (agent: Agent) => void;
    /** Under the member's own agents: their pager, when there is more than one page. */
    readonly pager?: ReactNode;
    /** What the grid shows when nothing matches or there is nothing yet. */
    readonly empty: ReactNode;
}

/** The member's agents, then the built-in ones in a section of their own, as cards. */
export function AgentsGrid({
    own,
    builtIn,
    showOwn,
    loading,
    activity,
    openId,
    morphId,
    onOpen,
    pager,
    empty,
}: AgentsGridProps) {
    if (loading) {
        return (
            <div
                aria-busy="true"
                className="grid grid-cols-1 gap-3 min-[30rem]:grid-cols-2 md:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]"
            >
                <span className="sr-only" role="status">
                    {m.loading()}
                </span>
                {Array.from({ length: SKELETON_CARDS }, (_, index) => (
                    <Skeleton key={index} shape="block" className="h-44 w-full" />
                ))}
            </div>
        );
    }
    if (own.length === 0 && builtIn.length === 0) return <>{empty}</>;
    const card = (agent: Agent) => (
        <AgentCard
            key={agent.id}
            agent={agent}
            activity={activity.get(agent.id) ?? NO_ACTIVITY}
            named={agent.id === morphId && agent.id !== openId}
            onOpen={onOpen}
        />
    );
    return (
        <div className="flex flex-col gap-6">
            {showOwn ? (
                <Section title={m.agents_group_own()} count={own.length} divided={false}>
                    {own.length === 0 ? (
                        <EmptyState variant="inline" icon={<Bot aria-hidden />} title={m.agents_empty_title()} />
                    ) : (
                        <CardGrid label={m.agents_group_own()}>{own.map(card)}</CardGrid>
                    )}
                    {pager}
                </Section>
            ) : null}
            {builtIn.length === 0 ? null : (
                <Section
                    title={m.agents_group_built_in()}
                    count={builtIn.length}
                    description={m.agents_built_in_hint()}
                    divided={showOwn}
                >
                    <CardGrid label={m.agents_group_built_in()}>{builtIn.map(card)}</CardGrid>
                </Section>
            )}
        </div>
    );
}
