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
import { Activity, FileText, ListTodo, MessageSquare, Plug, Zap } from 'lucide-react';
import type { ReactNode } from 'react';

import type { FeatureRequirement } from '../../app/registry/feature';
import { useAllows } from '../../app/registry/use-visible-features';
import { AgentAvatar } from '../agents/agent-avatar';
import { splitTaskName } from '../tasks/task-name';
import {
    AgentCard,
    ChatCard,
    FileCard,
    IntegrationCard,
    MemberCard,
    MemberInitial,
    RunCard,
    TaskCard,
    TriggerCard,
} from './entity-cards';
import { ChipLink, StaticChip } from './entity-chip-core';
import type { ChipStatus } from './entity-chip-core';

interface Common {
    /** The entity's name as the engine reports it. Untrusted: text only. */
    readonly name: string;
    readonly status?: ChipStatus | undefined;
    readonly muted?: boolean | undefined;
    readonly className?: string | undefined;
}

/**
 * Agents, tasks, runs, chats, files, triggers, integrations and members by name, one API for all: a chip with a type
 * icon or the agent's avatar that opens the entity on click and shows a small card on hover or focus. `id: null` (a
 * name the engine could not resolve) or a member who may not open it gives a plain chip with no link or card.
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

const REQUIRES = {
    agent: { permission: 'agents.read' },
    task: { capability: KNOWN_CAPABILITIES.tasks, permission: 'tasks.read' },
    run: { capability: KNOWN_CAPABILITIES.runs, permission: 'runs.read' },
    chat: { permission: 'chats.read' },
    file: { capability: KNOWN_CAPABILITIES.files, permission: 'files.read' },
    trigger: { capability: KNOWN_CAPABILITIES.triggers, permission: 'triggers.read' },
    integration: { capability: KNOWN_CAPABILITIES.integrations, permission: 'integrations.read' },
    member: { capability: KNOWN_CAPABILITIES.members, permission: 'members.read' },
} as const satisfies Readonly<Record<EntityChipProps['kind'], FeatureRequirement>>;

const ICONS = {
    task: <ListTodo aria-hidden />,
    run: <Activity aria-hidden />,
    chat: <MessageSquare aria-hidden />,
    file: <FileText aria-hidden />,
    trigger: <Zap aria-hidden />,
    integration: <Plug aria-hidden />,
} as const;

export function EntityChip(props: EntityChipProps) {
    const allowed = useAllows(REQUIRES[props.kind]);
    const { name, status, muted, className } = props;
    const label = props.kind === 'task' ? splitTaskName(name).readable : name;
    const look = { label, status, muted, className };
    const leading: ReactNode =
        props.kind === 'agent' ? (
            <AgentAvatar
                name={name}
                agentKey={props.id ?? undefined}
                profile={props.profile ?? { avatarUrl: null, color: null }}
                size="2xs"
            />
        ) : props.kind === 'member' ? (
            <MemberInitial name={name} />
        ) : (
            ICONS[props.kind]
        );
    if (props.id === null || !allowed) return <StaticChip {...look} leading={leading} />;
    switch (props.kind) {
        case 'agent':
            return (
                <ChipLink
                    to="/agents/$agentId"
                    params={{ agentId: props.id }}
                    {...look}
                    leading={leading}
                    card={<AgentCard agentId={props.id} name={name} />}
                />
            );
        case 'task':
            return (
                <ChipLink
                    to="/tasks/$taskId"
                    params={{ taskId: props.id }}
                    {...look}
                    leading={leading}
                    card={<TaskCard taskId={props.id} name={name} />}
                />
            );
        case 'run':
            return (
                <ChipLink
                    to="/runs/$runId"
                    params={{ runId: props.id }}
                    {...look}
                    leading={leading}
                    card={<RunCard runId={props.id} name={name} />}
                />
            );
        case 'chat':
            return (
                <ChipLink
                    to="/chats/$chatId"
                    params={{ chatId: props.id }}
                    {...look}
                    leading={leading}
                    card={<ChatCard chatId={props.id} name={name} />}
                />
            );
        case 'file':
            return (
                <ChipLink
                    to="/files"
                    search={{ file: props.id }}
                    {...look}
                    leading={leading}
                    card={<FileCard fileId={props.id} name={name} />}
                />
            );
        case 'trigger':
            return (
                <ChipLink
                    to="/triggers/$triggerId"
                    params={{ triggerId: props.id }}
                    {...look}
                    leading={leading}
                    card={<TriggerCard triggerId={props.id} name={name} />}
                />
            );
        case 'integration':
            return (
                <ChipLink
                    to="/integrations/$integrationId"
                    params={{ integrationId: props.id }}
                    {...look}
                    leading={leading}
                    card={<IntegrationCard integrationId={props.id} name={name} />}
                />
            );
        case 'member':
            return (
                <ChipLink
                    to="/members"
                    {...look}
                    leading={leading}
                    card={<MemberCard memberId={props.id} name={name} />}
                />
            );
    }
}
