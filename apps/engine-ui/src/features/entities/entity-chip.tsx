import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type {
    AgentId,
    AgentProfile,
    ChatId,
    FileId,
    IntegrationId,
    MemberId,
    RunId,
    TaskId,
    TriggerId,
} from '@ptbk/engine-api';
import { EntityChip as ChipCore } from '@ptbk/ui';
import type { EntityChipTriggerProps, StatusTone } from '@ptbk/ui';
import { Link } from '@tanstack/react-router';
import { Activity, FileText, ListTodo, MessageSquare, Plug, User, Zap } from 'lucide-react';
import type { ReactNode } from 'react';

import type { FeatureRequirement } from '../../app/registry/feature';
import { useAllows } from '../../app/registry/use-visible-features';
import { AgentAvatar } from '../agents/agent-avatar';
import { agentColor } from '../chat/references/agent-color';
import { splitTaskName } from '../tasks/task-name';
import {
    AgentCard,
    ChatCard,
    FileCard,
    IntegrationCard,
    MemberCard,
    RunCard,
    TaskCard,
    TriggerCard,
} from './entity-cards';

interface Common {
    /** The entity's name as the engine reports it. Untrusted: rendered as a text node only. */
    readonly name: string;
    /** A dot after the name; `statusLabel` says it in words for screen readers. */
    readonly status?: StatusTone | undefined;
    readonly statusLabel?: string | undefined;
    /** In running text the chip wraps with it; elsewhere it stays on one line and truncates. */
    readonly wrap?: boolean | undefined;
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
              readonly profile?: Pick<AgentProfile, 'avatarUrl' | 'color'> | undefined;
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
    const allowed = useAllows(ENTITY_REQUIREMENTS[props.kind]);
    const { name, status, statusLabel, wrap, className } = props;
    // A task's instance stamp stays on its card and detail page; in a chip only the readable name matters.
    const label = props.kind === 'task' ? splitTaskName(name).readable : name;
    const target = allowed ? targetOf(props) : null;
    const look =
        props.kind === 'agent'
            ? {
                  tone: 'agent' as const,
                  tint: agentColor(props.profile?.color, props.id ?? name),
                  leading: (
                      <AgentAvatar
                          name={name}
                          agentKey={props.id ?? name}
                          profile={props.profile ?? { avatarUrl: null, color: null }}
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
                : { render: target.link, hovercard: { label: name, content: target.card } })}
        />
    );
}
