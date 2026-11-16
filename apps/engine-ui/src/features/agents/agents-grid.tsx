import type { Agent } from '@ptbk/engine-api';
import { EmptyState, RelativeTime, Section, Skeleton, StatusDot, tintStyle, viewTransitionStyle } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';
import { Bot } from 'lucide-react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { agentColor } from '../chat/references/agent-color';
import { isWorking, NO_ACTIVITY } from './agent-activity';
import type { AgentActivity } from './agent-activity';
import { AgentAvatar } from './agent-avatar';

const SKELETON_CARDS = 6;

/** The words and dot a card and the panel lead with, from the activity alone, so no card asks the engine anything. */
export function activityStatus(activity: AgentActivity): { readonly tone: StatusTone; readonly label: string } {
    if (isWorking(activity)) return { tone: 'live', label: m.agent_state_working() };
    if (activity.chats.some((chat) => chat.questions.length > 0)) return { tone: 'warning', label: m.chat_needs_you() };
    return { tone: 'neutral', label: m.agent_state_idle() };
}

/** "2 chats, 1 task" for working agents; nothing otherwise. */
export function workSummary(activity: AgentActivity): string | null {
    const chats = new Set(activity.working.map(({ chat }) => chat.id)).size;
    // A run of a task or a chat reply is already counted as that task or reply.
    const runs = activity.runs.filter((run) => (run.taskId ?? null) === null && run.chatId === null).length;
    const parts: string[] = [];
    if (chats > 0) parts.push(m.agents_card_chats({ count: chats }));
    if (activity.tasks.length > 0) parts.push(m.agents_card_tasks({ count: activity.tasks.length }));
    if (runs > 0) parts.push(m.agents_card_runs({ count: runs }));
    return parts.length === 0 ? null : parts.join(', ');
}

/** When the agent last spoke in a thread in view: "last active 3 hours ago". */
function LastActive({ activity }: { readonly activity: AgentActivity }) {
    if (activity.lastActiveAt === null) return null;
    return (
        <>
            {m.agents_card_last_active()} <RelativeTime value={new Date(activity.lastActiveAt)} />
        </>
    );
}

/**
 * "Working · 2 chats, 1 task", else "Idle", with "· last active 3 hours ago" where there is room for it (the panel):
 * a light line, in tabular figures.
 */
export function StatusLine({
    activity,
    withLastActive = false,
    className,
}: {
    readonly activity: AgentActivity;
    readonly withLastActive?: boolean;
    readonly className?: string;
}) {
    const status = activityStatus(activity);
    const summary = workSummary(activity);
    let detail: ReactNode = summary;
    if (summary === null && withLastActive && activity.lastActiveAt !== null)
        detail = <LastActive activity={activity} />;
    return (
        <span className={cx('flex min-w-0 items-center gap-1.5 text-xs text-text-muted tabular-nums', className)}>
            <StatusDot tone={status.tone} />
            <span className="truncate">
                <span className={status.tone === 'neutral' ? undefined : 'font-medium text-text'}>{status.label}</span>
                {detail === null ? null : <span> · {detail}</span>}
            </span>
        </span>
    );
}

interface CardProps {
    readonly agent: Agent;
    readonly activity: AgentActivity;
    /** The open agent's card gives its names to the panel, which morphs out of it. */
    readonly open: boolean;
    readonly onOpen: (agent: Agent) => void;
}

/**
 * One agent as a card: its picture large, its name and a light status line. Hover lifts it and deepens its tint; the
 * character pulses while it works or blinks once when idle (motion only where it is allowed, in agents-grid.css). The
 * role and last activity fade in under the name. Clicking opens the agent's panel, which morphs out of the card.
 */
function AgentCard({ agent, activity, open, onOpen }: CardProps) {
    const tint = agentColor(agent.profile.color, agent.id);
    const working = isWorking(activity);
    return (
        <li className="flex min-w-0">
            <button
                type="button"
                aria-haspopup="dialog"
                data-agent-card={agent.id}
                onClick={() => {
                    onOpen(agent);
                }}
                style={{ ...tintStyle(tint), ...(open ? {} : viewTransitionStyle('agent-card', agent.id)) }}
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
                    style={open ? undefined : viewTransitionStyle('agent-art', agent.id)}
                >
                    <AgentAvatar
                        name={agent.name}
                        agentKey={agent.id}
                        profile={agent.profile}
                        origin={agent.origin}
                        size="xl"
                    />
                </span>
                <span className="flex w-full min-w-0 flex-col gap-1">
                    {/* Names and roles come from Books: React renders them as text. */}
                    <span className="truncate text-sm font-semibold">{agent.name}</span>
                    <StatusLine activity={activity} />
                    {/* Read by screen readers always; on a device with hover it fades in with the pointer. */}
                    <span
                        className={cx(
                            'flex min-h-12 flex-col gap-0.5 pt-1 text-xs text-text-muted',
                            '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-visible:opacity-100',
                            'motion-safe:transition-opacity motion-safe:duration-(--motion-state)',
                        )}
                    >
                        <span className="line-clamp-2 break-words">{agent.profile.description}</span>
                        {isWorking(activity) || activity.lastActiveAt === null ? null : (
                            <span className="truncate tabular-nums">
                                <LastActive activity={activity} />
                            </span>
                        )}
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
            open={agent.id === openId}
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
