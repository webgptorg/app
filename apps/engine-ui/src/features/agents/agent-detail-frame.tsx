import type { Agent } from '@ptbk/engine-api';
import { Button, Tabs } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link as RouterLink, Outlet, useMatches, useMatchRoute, useNavigate } from '@tanstack/react-router';
import { MessageSquare, Pencil, Play, Square } from 'lucide-react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink } from '../../app/link';
import { AGENT_TABS } from '../../app/registry/feature';
import type { AgentTabEntry } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { useAgentActions } from './agent-actions';
import type { AgentActions } from './agent-actions';
import { AgentAvatar } from './agent-avatar';
import { AgentStateBadge, AgentVisibilityBadge } from './agent-badges';
import { useAgentIdParam } from './agent-detail-route';
import { AgentLiveState } from './agent-live-state';
import { useAgentTabs } from './agent-tabs';
import { agentDetailQueryOptions } from './agents-queries';

const RUNNING_STATES: ReadonlySet<string> = new Set(['running', 'working']);

/** A tab's route with this agent's ID; registry paths are typed per route, so the params are given untyped. */
const tabParams = (agent: Agent) => ({ agentId: agent.id }) as never;

function RunControl({
    agent,
    actions,
    size,
}: {
    readonly agent: Agent;
    readonly actions: AgentActions;
    readonly size: 'sm' | 'md';
}) {
    return (
        <AgentLiveState agentId={agent.id}>
            {(status) =>
                status.kind === 'state' && RUNNING_STATES.has(status.state) ? (
                    <Button
                        size={size}
                        loading={actions.isChangingRunState}
                        onClick={() => {
                            actions.stop(agent);
                        }}
                    >
                        <Square aria-hidden className="size-4" />
                        {m.agent_action_stop()}
                    </Button>
                ) : (
                    <Button
                        size={size}
                        loading={actions.isChangingRunState}
                        onClick={() => {
                            actions.start(agent);
                        }}
                    >
                        <Play aria-hidden className="size-4" />
                        {m.agent_action_start()}
                    </Button>
                )
            }
        </AgentLiveState>
    );
}

function TabLink({
    agent,
    tab,
    size,
}: {
    readonly agent: Agent;
    readonly tab: AgentTabEntry | undefined;
    readonly size: 'sm' | 'md';
}) {
    if (tab === undefined) return null;
    const Icon = tab.id === AGENT_TABS.chat.id ? MessageSquare : Pencil;
    return (
        <ButtonLink
            to={tab.to}
            params={tabParams(agent)}
            variant={tab.id === AGENT_TABS.chat.id ? 'primary' : 'secondary'}
            size={size}
        >
            <Icon aria-hidden className="size-4" />
            {tab.id === AGENT_TABS.chat.id ? m.agent_action_chat() : m.agent_action_edit()}
        </ButtonLink>
    );
}

/**
 * The agent page: identity, live status and primary actions above the tabs the registry provides. It never imports a
 * tab's code; each tab is its own route, rendered in the selected panel. A route that sets `staticData.fillViewport`
 * (a chat) gets a one-line header and the rest of the screen, so its composer is in view on a phone too.
 */
export function AgentDetailFrame() {
    const agentId = useAgentIdParam();
    const { data: agent } = useSuspenseQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    const navigate = useNavigate();
    const { can } = usePermissions();
    const actions = useAgentActions({
        onDeleted: () => {
            void navigate({ to: '/agents' });
        },
    });
    const tabs = useAgentTabs();
    const matchRoute = useMatchRoute();
    // A tab owns its nested pages too (a chat under Chat); the most specific matching tab wins over Overview.
    const selected =
        tabs
            .filter((tab) => matchRoute({ to: tab.to, params: tabParams(agent), fuzzy: true }) !== false)
            .toSorted((a, b) => b.to.length - a.to.length)[0] ?? tabs[0];
    const fill = useMatches({ select: (matches) => matches.some((match) => match.staticData.fillViewport === true) });
    // Inside a chat, "Chat" would only lead back to the list, which the chat's own back link already does.
    const chatTab = fill ? undefined : tabs.find((tab) => tab.id === AGENT_TABS.chat.id);
    const actionSize = fill ? 'sm' : 'md';
    const bookTab = can('agents.write') ? tabs.find((tab) => tab.id === AGENT_TABS.book.id) : undefined;

    return (
        <section
            aria-labelledby="page-title"
            className={cx(
                'flex min-w-0 flex-col',
                fill ? 'h-(--main-fill-height) min-h-[30rem] gap-3 md:gap-4' : 'gap-6',
            )}
        >
            <header className={cx('flex flex-wrap justify-between', fill ? 'items-center gap-3' : 'items-start gap-4')}>
                <div className={cx('flex min-w-0', fill ? 'items-center gap-3' : 'items-start gap-4')}>
                    <AgentAvatar name={agent.name} profile={agent.profile} size={fill ? 'sm' : 'lg'} />
                    <div
                        className={cx(
                            'flex min-w-0',
                            fill ? 'flex-wrap items-center gap-x-3 gap-y-1' : 'flex-col gap-1',
                        )}
                    >
                        <h1 id="page-title" className={cx('font-semibold break-words', fill ? 'text-lg' : 'text-2xl')}>
                            {agent.name}
                        </h1>
                        {fill || agent.profile.description === '' ? null : (
                            <p className="max-w-prose text-sm break-words text-text-muted">
                                {agent.profile.description}
                            </p>
                        )}
                        <div className={cx('flex flex-wrap items-center gap-2', !fill && 'mt-1')}>
                            <AgentLiveState agentId={agent.id}>
                                {(status) => <AgentStateBadge status={status} />}
                            </AgentLiveState>
                            <AgentVisibilityBadge visibility={agent.visibility} />
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <TabLink agent={agent} tab={chatTab} size={actionSize} />
                    <TabLink agent={agent} tab={bookTab} size={actionSize} />
                    {actions.canRun ? <RunControl agent={agent} actions={actions} size={actionSize} /> : null}
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
