import type { NotificationTarget, ReadNotification } from '@ptbk/engine-api';
import { Button, EmptyState, ErrorState, RelativeTime, Skeleton } from '@ptbk/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Bell, CircleAlert, Inbox, KeyRound, MessageCircleQuestion } from 'lucide-react';
import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { AI_TOOLS_READ } from '../ai-tools/ai-tools-queries';
import { ENTITY_REQUIREMENTS } from '../entities/entity-chip';
import { Page } from '../shell/page';
import { inboxQueryOptions } from './notifications-queries';
import { useMarkSeenOnView } from './use-mark-seen';

type Kind = ReadNotification['kind'];

const KIND_LABELS: Readonly<Record<Kind, () => string>> = {
    'agent-waiting': m.inbox_kind_agent_waiting,
    'task-failed': m.inbox_kind_task_failed,
    'tool-sign-in': m.inbox_kind_tool_sign_in,
    unknown: m.inbox_kind_unknown,
};

const KIND_ICONS: Readonly<Record<Kind, ReactNode>> = {
    'agent-waiting': <MessageCircleQuestion aria-hidden />,
    'task-failed': <CircleAlert aria-hidden />,
    'tool-sign-in': <KeyRound aria-hidden />,
    unknown: <Bell aria-hidden />,
};

/** Where each kind of target is handled, and whether this member may open it there. */
function useTargetAccess(): Readonly<Record<NotificationTarget['kind'], boolean>> {
    return {
        chat: useAllows(ENTITY_REQUIREMENTS.chat),
        run: useAllows(ENTITY_REQUIREMENTS.run),
        task: useAllows(ENTITY_REQUIREMENTS.task),
        'ai-tool': useAllows(AI_TOOLS_READ),
    };
}

/** The item's title, a link to where it is handled when there is one the member may open. Text only, always. */
function ItemTitle({
    item,
    canOpen,
}: {
    readonly item: ReadNotification;
    readonly canOpen: Readonly<Record<NotificationTarget['kind'], boolean>>;
}) {
    const className = cx('[overflow-wrap:anywhere]', item.seenAt === null ? 'font-medium text-text' : 'text-text');
    const target = item.target;
    if (target === null || !canOpen[target.kind]) return <span className={className}>{item.title}</span>;
    const link = { variant: 'standalone' as const, className };
    switch (target.kind) {
        case 'chat':
            return (
                <Link to="/chats/$chatId" params={{ chatId: target.chatId }} {...link}>
                    {item.title}
                </Link>
            );
        case 'run':
            return (
                <Link to="/runs/$runId" params={{ runId: target.runId }} {...link}>
                    {item.title}
                </Link>
            );
        case 'task':
            return (
                <Link to="/tasks/$taskId" params={{ taskId: target.taskId }} {...link}>
                    {item.title}
                </Link>
            );
        case 'ai-tool':
            return (
                <Link to="/settings/ai-tools" search={{ signIn: target.aiToolId }} {...link}>
                    {item.title}
                </Link>
            );
    }
}

function InboxItem({
    item,
    canOpen,
}: {
    readonly item: ReadNotification;
    readonly canOpen: Readonly<Record<NotificationTarget['kind'], boolean>>;
}) {
    const unseen = item.seenAt === null;
    return (
        <li className="flex items-start gap-3 py-3" data-unseen={unseen ? '' : undefined}>
            <span
                className={cx(
                    'mt-0.5 flex shrink-0 [&>svg]:size-4',
                    unseen ? '[&>svg]:text-text' : '[&>svg]:text-text-subtle',
                )}
            >
                {KIND_ICONS[item.kind]}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="flex items-baseline gap-2 text-sm">
                    <ItemTitle item={item} canOpen={canOpen} />
                    {unseen ? (
                        <span className="size-1.5 shrink-0 self-center rounded-pill bg-accent">
                            <span className="sr-only">{m.inbox_unseen()}</span>
                        </span>
                    ) : null}
                </p>
                {item.detail === null ? null : (
                    <p className="line-clamp-3 text-sm whitespace-pre-line text-text-muted [overflow-wrap:anywhere]">
                        {item.detail}
                    </p>
                )}
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-subtle">
                    <span>{KIND_LABELS[item.kind]()}</span>
                    {item.audience === 'project' ? (
                        <>
                            <span aria-hidden>·</span>
                            <span>{m.inbox_for_project()}</span>
                        </>
                    ) : null}
                    <span aria-hidden>·</span>
                    <RelativeTime value={new Date(item.createdAt)} className="tabular-nums" />
                </p>
            </div>
        </li>
    );
}

function InboxSkeleton() {
    return (
        <div aria-busy="true" className="flex flex-col gap-4">
            {Array.from({ length: 3 }, (_, index) => (
                <div key={index} className="flex flex-col gap-2">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                </div>
            ))}
        </div>
    );
}

/**
 * The member's open notifications, newest first, each with a link to where it is handled. Titles and details may be
 * an agent's words: they render as text nodes only. Whatever the page shows unseen is marked seen, which lowers the
 * badge and the count the heartbeat may carry.
 */
export function InboxPage() {
    const inbox = useInfiniteQuery(inboxQueryOptions(useEngineApi()));
    const items = useMemo(() => inbox.data?.pages.flatMap((page) => page.items), [inbox.data]);
    useMarkSeenOnView(items);
    const canOpen = useTargetAccess();

    let content: ReactNode;
    if (items === undefined && inbox.isError) {
        content = (
            <ErrorState
                message={m.inbox_failed()}
                onRetry={() => {
                    void inbox.refetch();
                }}
                retrying={inbox.isFetching}
            />
        );
    } else if (items === undefined) {
        content = <InboxSkeleton />;
    } else if (items.length === 0) {
        content = (
            <EmptyState
                icon={<Inbox aria-hidden />}
                title={m.inbox_empty()}
                description={m.inbox_empty_body()}
                headingLevel={2}
            />
        );
    } else {
        content = (
            <>
                <ul aria-label={m.inbox_list_label()} className="flex flex-col divide-y divide-hairline">
                    {items.map((item) => (
                        <InboxItem key={item.id} item={item} canOpen={canOpen} />
                    ))}
                </ul>
                {inbox.isFetchNextPageError ? (
                    <ErrorState
                        message={m.inbox_more_failed()}
                        onRetry={() => {
                            void inbox.fetchNextPage();
                        }}
                        retrying={inbox.isFetchingNextPage}
                    />
                ) : inbox.hasNextPage ? (
                    <div className="flex justify-center">
                        <Button
                            variant="secondary"
                            loading={inbox.isFetchingNextPage}
                            onClick={() => {
                                void inbox.fetchNextPage();
                            }}
                        >
                            {m.inbox_show_more()}
                        </Button>
                    </div>
                ) : null}
            </>
        );
    }

    return (
        <Page title={m.inbox_title()} description={m.inbox_description()} width="reading">
            {content}
        </Page>
    );
}
