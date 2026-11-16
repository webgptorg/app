import type { Agent, ReadChat } from '@ptbk/engine-api';
import { Button, IconButton, RelativeTime, StatusPill, tintStyle, viewTransitionStyle } from '@ptbk/ui';
import { ArrowUpRight, ListTodo, MessageSquare, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { ButtonLink, Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { agentColor } from '../chat/references/agent-color';
import { StepLine } from '../chat/references/agent-hovercard';
import { formatClock, useElapsedMs } from '../chat/references/elapsed';
import { chatName } from '../chat/thread-list';
import { useNewChat } from '../chat/use-new-chat';
import { EntityChip } from '../entities/entity-chip';
import { chatPreview } from '../home/chat-preview';
import { usePermissions } from '../session/use-permissions';
import { splitTaskName } from '../tasks/task-name';
import { TaskStateBadge } from '../tasks/task-state';
import type { AgentActivity, AgentWorking } from './agent-activity';
import { AgentAvatar } from './agent-avatar';
import { activityStatus, StatusLine } from './agents-grid';
import { OverviewRow, OverviewRows } from './overview-parts';

const SHOWN_CHATS = 5;

/**
 * Drives the native `<dialog>` from React: shown in a layout effect, so a View Transition's update callback (which
 * commits synchronously) already sees it open and can morph the card into it. The browser makes the page behind it
 * inert and keeps focus inside; Esc and a click on the backdrop close it, and focus returns to the card.
 */
function useAgentDialog(onClose: () => void) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    });
    useLayoutEffect(() => {
        const dialog = dialogRef.current;
        if (dialog === null) return;
        const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!dialog.open) dialog.showModal();
        // The panel itself takes focus, so its name is read first and no control shows a ring before anyone types.
        dialog.focus();
        const onCancel = (event: Event) => {
            event.preventDefault();
            onCloseRef.current();
        };
        const onClick = (event: MouseEvent) => {
            if (event.target === dialog) onCloseRef.current();
        };
        dialog.addEventListener('cancel', onCancel);
        dialog.addEventListener('click', onClick);
        return () => {
            dialog.removeEventListener('cancel', onCancel);
            dialog.removeEventListener('click', onClick);
            if (dialog.open) dialog.close();
            const card = dialog.dataset['agent'] === undefined ? null : findCard(dialog.dataset['agent']);
            (card ?? opener)?.focus();
        };
    }, []);
    return dialogRef;
}

function findCard(agentId: string): HTMLElement | null {
    for (const card of document.querySelectorAll<HTMLElement>('[data-agent-card]')) {
        if (card.dataset['agentCard'] === agentId) return card;
    }
    return null;
}

function Timer({ since }: { readonly since: string }) {
    const elapsed = useElapsedMs(since);
    if (elapsed === null) return null;
    return <span className="shrink-0 text-xs text-text-muted tabular-nums">{formatClock(elapsed)}</span>;
}

/** A reply the agent is writing now: where, its latest step and how long it has been going. */
function WorkingRow({ entry }: { readonly entry: AgentWorking }) {
    const latest = entry.working.steps.at(-1);
    return (
        <li className="flex items-start gap-3 px-3 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm">
                    <span className="text-text-muted">{m.agent_panel_replying_in()}</span>
                    <Link
                        to="/chats/$chatId"
                        params={{ chatId: entry.chat.id }}
                        variant="standalone"
                        className="min-w-0 truncate font-medium text-text"
                    >
                        {chatName(entry.chat)}
                    </Link>
                </span>
                {latest === undefined ? null : <StepLine step={latest} />}
            </span>
            <Timer since={entry.working.startedAt} />
        </li>
    );
}

/** A thread as one row: title, a calm preview (never step text), when it last moved, and "Needs you" when it does. */
function ChatRow({ chat }: { readonly chat: ReadChat }) {
    const preview = chatPreview(chat, undefined);
    return (
        <li>
            <Link
                to="/chats/$chatId"
                params={{ chatId: chat.id }}
                variant="standalone"
                className="-mx-2 flex min-h-12 items-center gap-3 rounded-control px-2 py-2 text-text no-underline hover:bg-hover hover:no-underline"
            >
                <MessageSquare aria-hidden className="size-4 shrink-0 text-text-muted" />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{chatName(chat)}</span>
                        {chat.questions.length > 0 ? (
                            <StatusPill tone="warning" className="shrink-0">
                                {m.chat_needs_you()}
                            </StatusPill>
                        ) : null}
                    </span>
                    {preview === null ? null : (
                        <span
                            className={cx('truncate text-xs text-text-muted', preview.kind === 'working' && 'italic')}
                        >
                            {preview.kind === 'working' ? m.home_chat_working() : preview.text}
                        </span>
                    )}
                </span>
                <RelativeTime
                    value={new Date(chat.lastMessageAt ?? chat.updatedAt)}
                    className="shrink-0 text-xs text-text-muted tabular-nums"
                />
            </Link>
        </li>
    );
}

function PanelSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
    const id = useId();
    return (
        <section aria-labelledby={id} className="flex flex-col gap-1.5 border-t border-hairline pt-4">
            <h3 id={id} className="text-xs font-medium text-text-muted">
                {title}
            </h3>
            {children}
        </section>
    );
}

export interface AgentPanelProps {
    readonly agent: Agent;
    readonly activity: AgentActivity;
    readonly onClose: () => void;
}

/**
 * An agent at a glance, over the grid: what it is doing now, its chats and running tasks, and the ways to talk to it or
 * open it. The card morphs into it (`agent-card` and `agent-art` share their View Transition names with the card's),
 * and the URL keeps it open (`?agent=`), so it can be shared. On a phone it is a full-screen sheet.
 */
export function AgentPanel({ agent, activity, onClose }: AgentPanelProps) {
    const dialogRef = useAgentDialog(onClose);
    const titleId = useId();
    const { can } = usePermissions();
    const newChat = useNewChat();
    const status = activityStatus(activity);
    const tint = agentColor(agent.profile.color, agent.id);
    const chats = activity.chats.slice(0, SHOWN_CHATS);
    return (
        <dialog
            ref={dialogRef}
            data-ptbk-modal=""
            data-agent={agent.id}
            tabIndex={-1}
            aria-labelledby={titleId}
            style={{ ...tintStyle(tint), ...viewTransitionStyle('agent-card', agent.id) }}
            className={cx(
                'm-auto w-[min(40rem,calc(100%-2rem))] max-h-[calc(100dvh-4rem)] overflow-auto p-0',
                'rounded-surface border border-hairline text-text shadow-overlay',
                // The card's tint, a little deeper, so the panel reads as the card grown up.
                'bg-[color-mix(in_oklab,var(--tint)_6%,var(--color-raised))] outline-none',
                'max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none max-sm:rounded-none max-sm:border-0',
            )}
        >
            <div className="flex flex-col gap-5 p-6">
                <header className="flex items-start gap-4">
                    <span className="flex" style={viewTransitionStyle('agent-art', agent.id)}>
                        <AgentAvatar
                            name={agent.name}
                            agentKey={agent.id}
                            profile={agent.profile}
                            origin={agent.origin}
                            size="xl"
                        />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                            <h2 id={titleId} className="min-w-0 text-xl font-semibold tracking-display break-words">
                                {agent.name}
                            </h2>
                            <StatusPill tone={status.tone}>{status.label}</StatusPill>
                        </div>
                        {agent.profile.description === '' ? null : (
                            <p className="text-sm break-words text-text-muted">{agent.profile.description}</p>
                        )}
                    </div>
                    <IconButton
                        label={m.agent_panel_close()}
                        icon={<X aria-hidden className="size-4" />}
                        size="sm"
                        className="-me-2 -mt-1"
                        onClick={onClose}
                    />
                </header>
                <div className="flex flex-wrap gap-2">
                    {can('chats.write') ? (
                        <Button
                            variant="primary"
                            loading={newChat.starting}
                            onClick={() => {
                                newChat.start(agent.id);
                            }}
                        >
                            <MessageSquare aria-hidden className="size-4" />
                            {m.agent_action_chat()}
                        </Button>
                    ) : null}
                    <ButtonLink to="/agents/$agentId" params={{ agentId: agent.id }} variant="secondary">
                        <ArrowUpRight aria-hidden className="size-4" />
                        {m.agent_panel_open()}
                    </ButtonLink>
                </div>
                <PanelSection title={m.agent_panel_now()}>
                    {activity.working.length === 0 ? (
                        <StatusLine activity={activity} withLastActive className="py-1 text-sm" />
                    ) : (
                        <ul className="soft-surface flex flex-col divide-y divide-hairline [--tint:var(--color-live)]">
                            {activity.working.map((entry) => (
                                <WorkingRow key={entry.chat.id} entry={entry} />
                            ))}
                        </ul>
                    )}
                </PanelSection>
                {activity.tasks.length === 0 ? null : (
                    <PanelSection title={m.agent_panel_tasks()}>
                        <OverviewRows>
                            {activity.tasks.map((task) => (
                                <OverviewRow key={task.id} lead={<ListTodo aria-hidden />} at={task.updatedAt}>
                                    <EntityChip kind="task" id={task.id} name={splitTaskName(task.name).readable} />
                                    <TaskStateBadge state={task.state} />
                                </OverviewRow>
                            ))}
                        </OverviewRows>
                    </PanelSection>
                )}
                <PanelSection title={m.agent_panel_chats()}>
                    {chats.length === 0 ? (
                        <p className="py-1 text-sm text-text-muted">{m.agent_panel_no_chats()}</p>
                    ) : (
                        <ul className="flex flex-col">
                            {chats.map((chat) => (
                                <ChatRow key={chat.id} chat={chat} />
                            ))}
                        </ul>
                    )}
                </PanelSection>
            </div>
        </dialog>
    );
}
