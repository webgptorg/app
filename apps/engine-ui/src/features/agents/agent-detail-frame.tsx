import type { Agent } from '@ptbk/engine-api';
import { ActionMenu, Button, Tabs, viewTransitionStyle } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link as RouterLink, Outlet, useMatches, useMatchRoute, useNavigate } from '@tanstack/react-router';
import { ChevronRight, MessageSquare, Square } from 'lucide-react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { AGENT_TABS } from '../../app/registry/feature';
import type { AgentTabEntry } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { useDocumentTitle } from '../shell/document-title';
import { Breadcrumbs, Crumb } from '../shell/page';
import { NARROW_QUERY, useMediaQuery } from '../shell/use-media-query';
import { useAgentActions } from './agent-actions';
import { AgentAvatar } from './agent-avatar';
import { AgentVisibilityBadge } from './agent-badges';
import { NO_ACTIVITY, useAgentActivity } from './agent-activity';
import { AgentStatusPill } from './agent-status';
import { useAgentIdParam } from './agent-detail-route';
import { AgentStop } from './agent-live-state';
import { useAgentTabs } from './agent-tabs';
import { agentDetailQueryOptions } from './agents-queries';

/** A tab's route with this agent's ID; registry paths are typed per route, so the params are given untyped. */
const tabParams = (agent: Agent) => ({ agentId: agent.id }) as never;

function AgentsCrumb() {
    return <Crumb to="/agents">{m.agents_title()}</Crumb>;
}

/** Shown only while there is work to stop; there is no "Start", since agents work on demand. */
function StopControl({ agent, size }: { readonly agent: Agent; readonly size: 'sm' | 'md' }) {
    return (
        <AgentStop agent={agent}>
            {(control) =>
                control === null || control.state === 'none' ? null : (
                    <Button
                        size={size}
                        loading={control.isPending || control.state === 'stopping'}
                        disabled={control.state === 'stopping'}
                        onClick={control.stop}
                    >
                        {control.state === 'stopping' ? null : <Square aria-hidden className="size-4" />}
                        {control.state === 'stopping' ? m.agent_stopping() : m.agent_action_stop()}
                    </Button>
                )
            }
        </AgentStop>
    );
}

function ChatLink({
    agent,
    tab,
    size,
}: {
    readonly agent: Agent;
    readonly tab: AgentTabEntry | undefined;
    readonly size: 'sm' | 'md';
}) {
    if (tab === undefined) return null;
    return (
        <ButtonLink to={tab.to} params={tabParams(agent)} variant="primary" size={size}>
            <MessageSquare aria-hidden className="size-4" />
            {m.agent_action_chat()}
        </ButtonLink>
    );
}

/**
 * The agent page: where it sits (Agents ›), identity, live status and primary actions above the tabs the registry
 * provides. It never imports a tab's code; each tab is its own route, rendered in the selected panel. A route that sets `staticData.fillViewport`
 * (a chat, the book) gets a one-line header and the rest of the screen, so its composer is in view on a phone too.
 * "Chat" is the one primary action; the book has its own tab, so the header offers no "Edit".
 */
export function AgentDetailFrame() {
    const agentId = useAgentIdParam();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const navigate = useNavigate();
    const actions = useAgentActions({
        onDeleted: () => {
            void navigate({ to: '/agents' });
        },
    });
    const tabs = useAgentTabs();
    const activity = useAgentActivity().get(agentId) ?? NO_ACTIVITY;
    const matchRoute = useMatchRoute();
    // A tab owns its nested pages too (a chat under Chat); the most specific matching tab wins over Overview.
    const selected =
        tabs
            .filter((tab) => matchRoute({ to: tab.to, params: tabParams(agent), fuzzy: true }) !== false)
            .toSorted((a, b) => b.to.length - a.to.length)[0] ?? tabs[0];
    useDocumentTitle(...(selected === undefined ? [] : [selected.label()]), agent.name);
    const fill = useMatches({ select: (matches) => matches.some((match) => match.staticData.fillViewport === true) });
    // In the Chat tab, "Chat" would only lead to a fresh conversation; the recent list's "New chat" does that.
    const chatTab = selected?.id === AGENT_TABS.chat.id ? undefined : tabs.find((tab) => tab.id === AGENT_TABS.chat.id);
    // On a phone the full header would take a third of every tab; the description is on Overview anyway.
    const narrow = useMediaQuery(NARROW_QUERY);
    const compact = fill || narrow;

    return (
        <section
            aria-labelledby="page-title"
            className={cx('flex min-w-0 flex-col', fill ? 'min-h-[30rem] flex-1 gap-3 md:gap-4' : 'gap-5')}
        >
            <header className={cx('flex min-w-0 flex-col', compact ? 'gap-2 pt-1' : 'gap-4 pt-3')}>
                {compact ? null : <Breadcrumbs trail={[<AgentsCrumb key="agents" />]} />}
                <div className="flex min-w-0 items-center justify-between gap-3">
                    <div className={cx('flex min-w-0 flex-1 items-center', compact ? 'gap-2.5' : 'gap-4')}>
                        {compact ? (
                            <span className="hidden shrink-0 items-center gap-1 text-sm text-text-muted sm:flex">
                                <AgentsCrumb />
                                <ChevronRight aria-hidden className="size-3.5 opacity-70" />
                            </span>
                        ) : null}
                        <AgentAvatar
                            name={agent.name}
                            agentKey={agent.id}
                            profile={agent.profile}
                            origin={agent.origin}
                            size={compact ? 'sm' : 'lg'}
                        />
                        <div className="flex min-w-0 flex-col gap-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                                <h1
                                    id="page-title"
                                    className={cx(
                                        'min-w-0 font-semibold tracking-display',
                                        compact ? 'truncate text-base' : 'text-2xl [overflow-wrap:anywhere]',
                                    )}
                                >
                                    {/* The list row's name morphs into this title. */}
                                    <span style={viewTransitionStyle('agent-title', agent.id)}>{agent.name}</span>
                                </h1>
                                <AgentStatusPill agentId={agent.id} activity={activity} />
                                {/* Only public is worth a word up here: anyone with the link can talk to it. */}
                                {agent.visibility === 'public' ? <AgentVisibilityBadge visibility="public" /> : null}
                            </div>
                            {compact || agent.profile.description === '' ? null : (
                                <p className="line-clamp-2 max-w-prose text-sm break-words text-text-muted">
                                    {agent.profile.description}
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <StopControl agent={agent} size="sm" />
                        <ChatLink agent={agent} tab={chatTab} size={compact ? 'sm' : 'md'} />
                        <ActionMenu items={actions.menuEntries(agent)} size={compact ? 'sm' : 'md'} />
                    </div>
                </div>
            </header>
            <Tabs
                fill={fill}
                label={m.agent_tabs_label({ name: agent.name })}
                activation="manual"
                selectedId={selected?.id ?? ''}
                onSelect={(id) => {
                    const tab = tabs.find((candidate) => candidate.id === id);
                    if (tab !== undefined) void navigate({ to: tab.to, params: tabParams(agent) });
                }}
                tabs={tabs.map((tab) => ({
                    id: tab.id,
                    label: tab.label(),
                    panel: tab.id === selected?.id ? <Outlet /> : null,
                }))}
                renderTab={(definition, props) => {
                    const tab = tabs.find((candidate) => candidate.id === definition.id);
                    return tab === undefined ? null : (
                        <RouterLink to={tab.to} params={tabParams(agent)} activeOptions={{ exact: true }} {...props} />
                    );
                }}
            />
            {actions.dialogs}
        </section>
    );
}
