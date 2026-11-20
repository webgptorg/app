import type { ReadBrowserHelpRequest } from '@ptbk/engine-api';
import { ActionMenu, Button, STATUS_TINT_CLASSES, StatusPill } from '@ptbk/ui';
import { Ban, Eye, Globe, LogIn, MousePointerClick, ShieldQuestion } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { cx } from '../../app/cx';
import { ButtonLink } from '../../app/link';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { helpTitle, whereLabel } from './browser-labels';
import { CONTROL_REQUIREMENT } from './browser-queries';
import { useCurrentLiveSession } from './live-sessions';
import { useAgentName } from './use-agent-name';
import { useControlTab, useDismissHelp, useWatchTab } from './use-browser-actions';

function ReasonIcon({ reason }: { readonly reason: ReadBrowserHelpRequest['reason'] }) {
    switch (reason) {
        case 'login':
            return <LogIn aria-hidden />;
        case 'captcha':
            return <ShieldQuestion aria-hidden />;
        case 'confirmation':
            return <MousePointerClick aria-hidden />;
        case 'blocked':
            return <Ban aria-hidden />;
        case 'other':
        case 'unknown':
            return <Globe aria-hidden />;
    }
}

/** The member's own open session on this tab, which the item opens instead of starting another. */
export function useOwnSessionOn(tabId: string): string | null {
    const current = useCurrentLiveSession();
    const live = useSyncExternalStore(
        current?.subscribe ?? noSubscription,
        () => current !== null && current.getView().endReason === null,
    );
    return live && current?.tabId === tabId ? current.id : null;
}

const noSubscription = () => () => undefined;

/**
 * An agent stuck on a page only a human gets past: why, where, and its own short message, which is model output and
 * stays a text node. One click takes the tab over (behind step-up); declining sits in the overflow menu.
 */
export function HelpRequestItem({ request }: { readonly request: ReadBrowserHelpRequest }) {
    const agent = useAgentName(request.agentId) ?? m.browser_an_agent();
    const canControl = useAllows(CONTROL_REQUIREMENT);
    const control = useControlTab();
    const watch = useWatchTab();
    const dismiss = useDismissHelp();
    const own = useOwnSessionOn(request.tabId);
    const pending = request.status === 'pending';
    let action;
    if (own !== null) {
        action = (
            <ButtonLink to="/browser/$sessionId" params={{ sessionId: own }} size="sm">
                {m.browser_open()}
            </ButtonLink>
        );
    } else if (pending && canControl) {
        action = (
            <Button
                size="sm"
                loading={control.isPending}
                onClick={() => {
                    control.mutate({ tabId: request.tabId });
                }}
            >
                {m.browser_help_take_over()}
            </Button>
        );
    } else {
        action = (
            <Button
                size="sm"
                loading={watch.isPending}
                onClick={() => {
                    watch.mutate({ tabId: request.tabId });
                }}
            >
                {m.browser_help_watch()}
            </Button>
        );
    }
    const offersWatch = own === null && pending && canControl;
    return (
        <li className={cx('soft-surface flex flex-wrap items-start gap-3 px-4 py-3', STATUS_TINT_CLASSES.warning)}>
            <span className="mt-0.5 flex shrink-0 [&>svg]:size-5 [&>svg]:text-tint">
                <ReasonIcon reason={request.reason} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-sm font-medium [overflow-wrap:anywhere]">
                    {helpTitle(request.reason, agent)}
                    <span className="ms-1.5 font-normal text-text-muted">{whereLabel(request.origin)}</span>
                </span>
                {/* The agent's own words: model output, a text node only. */}
                {request.message.trim() === '' ? null : (
                    <q className="line-clamp-2 text-sm [overflow-wrap:anywhere] text-text-muted">{request.message}</q>
                )}
            </span>
            <span className="flex shrink-0 items-center gap-1 self-center">
                {pending ? null : (
                    <StatusPill tone="live" variant="quiet">
                        {m.browser_help_in_progress()}
                    </StatusPill>
                )}
                {action}
                {canControl && pending ? (
                    <ActionMenu
                        label={m.browser_help_actions()}
                        variant="ghost"
                        size="sm"
                        items={[
                            ...(offersWatch
                                ? [
                                      {
                                          kind: 'item' as const,
                                          id: 'watch',
                                          label: m.browser_help_watch(),
                                          icon: <Eye />,
                                          onSelect: () => {
                                              watch.mutate({ tabId: request.tabId });
                                          },
                                      },
                                      { kind: 'separator' as const, id: 'separator' },
                                  ]
                                : []),
                            {
                                kind: 'item',
                                id: 'dismiss',
                                label: m.browser_help_dismiss(),
                                icon: <Ban />,
                                tone: 'danger',
                                onSelect: () => {
                                    dismiss.mutate({ requestId: request.id });
                                },
                            },
                        ]}
                    />
                ) : null}
            </span>
        </li>
    );
}
