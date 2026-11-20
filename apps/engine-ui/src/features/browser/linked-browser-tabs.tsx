import type { ReadBrowserTab } from '@ptbk/engine-api';
import { Button, STATUS_TINT_CLASSES, StatusPill } from '@ptbk/ui';
import { Globe } from 'lucide-react';

import { cx } from '../../app/cx';
import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { tabState, whereLabel } from './browser-labels';
import { useBrowserTabs, useOpenHelpRequests } from './browser-queries';
import type { BrowserTabFilter } from './browser-queries';
import { HelpRequestItem, useOwnSessionOn } from './help-request-item';
import { useAgentName } from './use-agent-name';
import { useWatchTab } from './use-browser-actions';

function BrowserTabRow({ tab }: { readonly tab: ReadBrowserTab }) {
    const agent = useAgentName(tab.agentId);
    const state = tabState(tab.agentState);
    const watch = useWatchTab();
    const own = useOwnSessionOn(tab.id);
    return (
        <li className={cx('soft-surface flex flex-wrap items-center gap-3 px-4 py-2.5', STATUS_TINT_CLASSES.neutral)}>
            <Globe aria-hidden className="size-4 shrink-0 text-text-muted" />
            <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">
                {agent === null ? m.browser_title_generic() : m.browser_title_agent({ agent })}
                <span className="ms-1.5 font-normal text-text-muted">{whereLabel(tab.origin)}</span>
            </span>
            {state === null ? null : (
                <StatusPill tone={state.tone} variant="quiet">
                    {state.label}
                </StatusPill>
            )}
            {own === null ? (
                <Button
                    size="sm"
                    loading={watch.isPending}
                    onClick={() => {
                        watch.mutate({ tabId: tab.id });
                    }}
                >
                    {m.browser_help_watch()}
                </Button>
            ) : (
                <ButtonLink to="/browser/$sessionId" params={{ sessionId: own }} size="sm">
                    {m.browser_open()}
                </ButtonLink>
            )}
        </li>
    );
}

/**
 * The tabs agents work in for this run or chat, each with a way to watch it; one waiting for help shows its request
 * instead. Nothing at all on an engine without `browser-tab@1`, or while no agent has a tab open.
 */
export function LinkedBrowserTabs({
    filter,
    className,
}: {
    readonly filter: BrowserTabFilter;
    readonly className?: string;
}) {
    const tabs = useBrowserTabs(filter);
    const help = useOpenHelpRequests() ?? [];
    if (tabs.length === 0) return null;
    return (
        <ul className={cx('flex flex-col gap-2', className)} aria-label={m.browser_title_generic()}>
            {tabs.map((tab) => {
                const request = help.find((candidate) => candidate.id === tab.helpRequestId);
                return request === undefined ? (
                    <BrowserTabRow key={tab.id} tab={tab} />
                ) : (
                    <HelpRequestItem key={tab.id} request={request} />
                );
            })}
        </ul>
    );
}
