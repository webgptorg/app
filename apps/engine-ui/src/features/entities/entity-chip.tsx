import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type {
    AgentId,
    AgentOrigin,
    ChatId,
    FileId,
    IntegrationId,
    MemberId,
    RunId,
    TaskId,
    TriggerId,
} from '@ptbk/engine-api';
import { EntityChip as ChipCore, Hovercard } from '@ptbk/ui';
import type { EntityChipTriggerProps, HovercardOptions, StatusTone } from '@ptbk/ui';
import { Link } from '@tanstack/react-router';
import { Activity, FileText, ListTodo, MessageSquare, Plug, User, Zap } from 'lucide-react';
import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import type { FeatureRequirement } from '../../app/registry/feature';
import { useAllows } from '../../app/registry/use-visible-features';
import { AgentAvatar, NO_AGENT_PROFILE } from '../agents/agent-avatar';
import type { AgentAvatarProfile } from '../agents/agent-avatar';
import { useAgentLook } from '../home/use-agent-look';
import { agentColor } from '../chat/references/agent-color';
import { splitTaskName } from '../tasks/task-name';
import { CardFallback } from './card-fallback';
import type { AgentCardHere } from './entity-cards';

// The cards' queries and formatting load on the first hover, not with every screen that shows a chip: Home is part
// of the entry chunk, and a chip is there long before anyone opens its card.
const cards = () => import('./entity-cards');
const AgentCard = lazy(() => cards().then((module) => ({ default: module.AgentCard })));
const TaskCard = lazy(() => cards().then((module) => ({ default: module.TaskCard })));
const RunCard = lazy(() => cards().then((module) => ({ default: module.RunCard })));
const ChatCard = lazy(() => cards().then((module) => ({ default: module.ChatCard })));
const FileCard = lazy(() => cards().then((module) => ({ default: module.FileCard })));
const TriggerCard = lazy(() => cards().then((module) => ({ default: module.TriggerCard })));
const IntegrationCard = lazy(() => cards().then((module) => ({ default: module.IntegrationCard })));
const MemberCard = lazy(() => cards().then((module) => ({ default: module.MemberCard })));

interface Common {
    /** The entity's name as the engine reports it. Untrusted: rendered as a text node only. */
    readonly name: string;
    /** A dot after the name; `statusLabel` says it in words for screen readers. */
    readonly status?: StatusTone | undefined;
    readonly statusLabel?: string | undefined;
    /** In running text the chip wraps with it; elsewhere it stays on one line and truncates. */
    readonly wrap?: boolean | undefined;
    /** `false` inside another card: a quiet chip with no link and no hovercard of its own. */
    readonly interactive?: boolean | undefined;
    readonly className?: string | undefined;
}

/**
 * Agents, tasks, runs, chats, files, triggers, integrations and members by name, one API for all: a chip with a type
 * icon or the agent's avatar that opens the entity on click and shows a small card on hover or focus. `id: null` (a
 * name the engine could not resolve), or an entity the member may not open, gives a plain chip with no link or card.
 */
export type EntityChipProps = Common &
    (
        | {
              readonly kind: 'agent';
              readonly id: AgentId | null;
              /** Without it, the chip looks the agent up in the shared agents query for its picture and colour. */
              readonly profile?: AgentAvatarProfile | undefined;
              readonly origin?: AgentOrigin | undefined;
          }
        | { readonly kind: 'task'; readonly id: TaskId | null }
        | { readonly kind: 'run'; readonly id: RunId | null }
        | { readonly kind: 'chat'; readonly id: ChatId | null }
        | { readonly kind: 'file'; readonly id: FileId | null }
        | { readonly kind: 'trigger'; readonly id: TriggerId | null }
        | { readonly kind: 'integration'; readonly id: IntegrationId | null }
        | { readonly kind: 'member'; readonly id: MemberId | null }
    );

export type EntityKind = EntityChipProps['kind'];

/** What the member needs to open an entity of each kind: the same requirements its feature has (ADR 0016). */
export const ENTITY_REQUIREMENTS = {
    agent: { permission: 'agents.read' },
    task: { capability: KNOWN_CAPABILITIES.tasks, permission: 'tasks.read' },
    run: { capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' },
    chat: { permission: 'chats.read' },
    file: { capability: KNOWN_CAPABILITIES.files, permission: 'files.read' },
    trigger: { capability: KNOWN_CAPABILITIES.triggers, permission: 'triggers.read' },
    integration: { capability: KNOWN_CAPABILITIES.integrations, permission: 'integrations.read' },
    member: { capability: KNOWN_CAPABILITIES.members, permission: 'members.read' },
} as const satisfies Readonly<Record<EntityKind, FeatureRequirement>>;

const ICONS: Readonly<Record<Exclude<EntityKind, 'agent'>, ReactNode>> = {
    task: <ListTodo />,
    run: <Activity />,
    chat: <MessageSquare />,
    file: <FileText />,
    trigger: <Zap />,
    integration: <Plug />,
    member: <User />,
};

interface Target {
    readonly link: (props: EntityChipTriggerProps) => ReactNode;
    readonly card: ReactNode;
}

/** Where a chip leads and what its card shows; `null` for a chip that only names the entity. */
function targetOf(props: EntityChipProps): Target | null {
    const { name } = props;
    if (props.id === null) return null;
    switch (props.kind) {
        case 'agent': {
            const agentId = props.id;
            return {
                link: (link) => <Link {...link} to="/agents/$agentId" params={{ agentId }} />,
                card: <AgentCard agentId={agentId} name={name} />,
            };
        }
        case 'task': {
            const taskId = props.id;
            return {
                link: (link) => <Link {...link} to="/tasks/$taskId" params={{ taskId }} />,
                card: <TaskCard taskId={taskId} name={name} />,
            };
        }
        case 'run': {
            const runId = props.id;
            return {
                link: (link) => <Link {...link} to="/runs/$runId" params={{ runId }} />,
                card: <RunCard runId={runId} name={name} />,
            };
        }
        case 'chat': {
            const chatId = props.id;
            return {
                link: (link) => <Link {...link} to="/chats/$chatId" params={{ chatId }} />,
                card: <ChatCard chatId={chatId} name={name} />,
            };
        }
        case 'file': {
            const fileId = props.id;
            return {
                link: (link) => <Link {...link} to="/files" search={{ file: fileId }} />,
                card: <FileCard fileId={fileId} name={name} />,
            };
        }
        case 'trigger': {
            const triggerId = props.id;
            return {
                link: (link) => <Link {...link} to="/triggers/$triggerId" params={{ triggerId }} />,
                card: <TriggerCard triggerId={triggerId} name={name} />,
            };
        }
        case 'integration': {
            const integrationId = props.id;
            return {
                link: (link) => <Link {...link} to="/integrations/$integrationId" params={{ integrationId }} />,
                card: <IntegrationCard integrationId={integrationId} name={name} />,
            };
        }
        case 'member': {
            const memberId = props.id;
            return {
                link: (link) => <Link {...link} to="/members" />,
                card: <MemberCard memberId={memberId} name={name} />,
            };
        }
    }
}

export function EntityChip(props: EntityChipProps) {
    if (props.kind === 'agent' && props.profile === undefined && props.id !== null) {
        return <LookedUpAgentChip {...props} id={props.id} />;
    }
    return <KnownEntityChip {...props} />;
}

function LookedUpAgentChip(props: EntityChipProps & { readonly kind: 'agent'; readonly id: AgentId }) {
    const look = useAgentLook(props.id);
    return <KnownEntityChip {...props} profile={look.profile} origin={look.origin} />;
}

function KnownEntityChip(props: EntityChipProps) {
    const allowed = useAllows(ENTITY_REQUIREMENTS[props.kind]);
    const { name, status, statusLabel, wrap, className } = props;
    // A task's instance stamp stays on its card and detail page; in a chip only the readable name matters.
    const label = props.kind === 'task' ? splitTaskName(name).readable : name;
    const target = allowed && props.interactive !== false ? targetOf(props) : null;
    const look =
        props.kind === 'agent'
            ? {
                  tone: 'agent' as const,
                  tint: agentColor(props.profile?.color, props.id ?? name),
                  leading: (
                      <AgentAvatar
                          name={name}
                          agentKey={props.id ?? name}
                          profile={props.profile ?? NO_AGENT_PROFILE}
                          origin={props.origin}
                          size="2xs"
                      />
                  ),
              }
            : { tone: 'neutral' as const, leading: ICONS[props.kind] };
    return (
        <ChipCore
            label={label}
            {...look}
            {...(status === undefined ? {} : { status })}
            {...(statusLabel === undefined ? {} : { statusLabel })}
            {...(wrap === undefined ? {} : { wrap })}
            {...(className === undefined ? {} : { className })}
            {...(target === null
                ? { interactive: false }
                : {
                      render: target.link,
                      hovercard: {
                          label: name,
                          content: <Suspense fallback={<CardFallback />}>{target.card}</Suspense>,
                      },
                  })}
        />
    );
}

/**
 * The agent's card as every reference to it shows it, for a hovercard on something other than this chip (a chat
 * chip that mentions on click). A thread passes what the agent does there as `here`.
 */
export function agentHovercard(agentId: AgentId, name: string, here?: AgentCardHere): HovercardOptions {
    return {
        label: name,
        content: (
            <Suspense fallback={<CardFallback />}>
                <AgentCard agentId={agentId} name={name} here={here} />
            </Suspense>
        ),
    };
}

/**
 * An agent in its own look rather than a chip (a chat turn's avatar and name), as a link to the agent with the same
 * card the chip has. An unresolved agent, or one the member may not open, is the plain content.
 */
export function AgentLink({
    id,
    name,
    canOpen,
    here,
    className,
    children,
}: {
    readonly id: AgentId | null;
    readonly name: string;
    /** The member may open agents (`ENTITY_REQUIREMENTS.agent`). */
    readonly canOpen: boolean;
    readonly here?: AgentCardHere | undefined;
    readonly className?: string | undefined;
    readonly children: ReactNode;
}) {
    if (id === null || !canOpen) return <span className={className}>{children}</span>;
    return (
        <Hovercard {...agentHovercard(id, name, here)}>
            {(trigger) => (
                <Link
                    {...trigger}
                    to="/agents/$agentId"
                    params={{ agentId: id }}
                    // The wash reaches past the content by its own padding, so hovering shifts nothing.
                    className={cx(
                        '-mx-1 rounded-control px-1 no-underline hover:bg-hover motion-safe:transition-[background-color] motion-safe:duration-(--motion-state)',
                        className,
                    )}
                >
                    {children}
                </Link>
            )}
        </Hovercard>
    );
}
