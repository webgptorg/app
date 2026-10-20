import type { Agent } from '@ptbk/engine-api';
import { Button, Tabs } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link as RouterLink, Outlet, useMatchRoute, useNavigate } from '@tanstack/react-router';
import { MessageSquare, Pencil, Play, Square } from 'lucide-react';

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

function RunControl({ agent, actions }: { readonly agent: Agent; readonly actions: AgentActions }) {
    return (
        <AgentLiveState agentId={agent.id}>
            {(status) =>
                status.kind === 'state' && RUNNING_STATES.has(status.state) ? (
                    <Button
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

function TabLink({ agent, tab }: { readonly agent: Agent; readonly tab: AgentTabEntry | undefined }) {
    if (tab === undefined) return null;
    const Icon = tab.id === AGENT_TABS.chat.id ? MessageSquare : Pencil;
    return (
        <ButtonLink
            to={tab.to}
            params={tabParams(agent)}
            variant={tab.id === AGENT_TABS.chat.id ? 'primary' : 'secondary'}
        >
            <Icon aria-hidden className="size-4" />
            {tab.id === AGENT_TABS.chat.id ? m.agent_action_chat() : m.agent_action_edit()}
        </ButtonLink>
    );
}

/**
 * The agent page: identity, live status and primary actions above the tabs the registry provides. It never imports a
 * tab's code; each tab is its own route, rendered in the selected panel.
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
    const selected = tabs.find((tab) => matchRoute({ to: tab.to, params: tabParams(agent) }) !== false) ?? tabs[0];
    const chatTab = tabs.find((tab) => tab.id === AGENT_TABS.chat.id);
    const bookTab = can('agents.write') ? tabs.find((tab) => tab.id === AGENT_TABS.book.id) : undefined;

    return (
        <section aria-labelledby="page-title" className="flex min-w-0 flex-col gap-6">
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-4">
                    <AgentAvatar name={agent.name} profile={agent.profile} size="lg" />
                    <div className="flex min-w-0 flex-col gap-1">
                        <h1 id="page-title" className="text-2xl font-semibold break-words">
                            {agent.name}
                        </h1>
                        {agent.profile.description === '' ? null : (
                            <p className="max-w-prose text-sm break-words text-text-muted">
                                {agent.profile.description}
                            </p>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                            <AgentLiveState agentId={agent.id}>
                                {(status) => <AgentStateBadge status={status} />}
                            </AgentLiveState>
                            <AgentVisibilityBadge visibility={agent.visibility} />
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <TabLink agent={agent} tab={chatTab} />
                    <TabLink agent={agent} tab={bookTab} />
                    {actions.canRun ? <RunControl agent={agent} actions={actions} /> : null}
                </div>
            </header>
            <Tabs
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
