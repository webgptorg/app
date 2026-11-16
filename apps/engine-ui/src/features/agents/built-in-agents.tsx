import type { Agent } from '@ptbk/engine-api';
import { Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { AgentAvatar } from './agent-avatar';
import { agentListQueryOptions } from './agents-queries';

/** Seven today (six core roles and Expert); room for a few more before this would need paging. */
const BUILT_IN_LIMIT = 50;

/**
 * The engine's own agents (core and system), under the member's: a quiet list with each agent's one-line role from
 * its Book. A search narrows it like the table above; nothing shows while it finds none or cannot load.
 */
export function BuiltInAgents({ q }: { readonly q: string | undefined }) {
    const list = useQuery(
        agentListQueryOptions(useEngineApi(), {
            origin: 'core,system',
            sort: 'name',
            limit: BUILT_IN_LIMIT,
            ...(q === undefined ? {} : { q }),
        }),
    );
    if (list.isPending) return <Skeleton className="h-24 w-full" />;
    const agents = [...(list.data?.items ?? [])].sort((a, b) => rank(a) - rank(b));
    if (agents.length === 0) return null;
    return (
        <section aria-labelledby="built-in-agents" className="flex flex-col gap-2">
            <div>
                <h2 id="built-in-agents" className="text-sm font-medium text-text-muted">
                    {m.agents_builtin_title()}
                </h2>
                <p className="text-sm text-text-muted">{m.agents_builtin_hint()}</p>
            </div>
            <ul className="flex flex-col divide-y divide-divider overflow-hidden rounded-surface border border-divider bg-raised">
                {agents.map((agent) => (
                    <BuiltInAgentRow key={agent.id} agent={agent} />
                ))}
            </ul>
        </section>
    );
}

/** Chatter, the one to talk to, first; then the other core agents by name; then the engine's own (Expert). */
function rank(agent: Agent): number {
    if (agent.origin !== 'core') return 2;
    return agent.name === 'Chatter' ? 0 : 1;
}

function BuiltInAgentRow({ agent }: { readonly agent: Agent }) {
    return (
        <li className="flex min-w-0 flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
            <Link
                to="/agents/$agentId"
                params={{ agentId: agent.id }}
                variant="standalone"
                className="inline-flex shrink-0 items-center gap-2 font-medium sm:w-40"
            >
                <AgentAvatar name={agent.name} agentKey={agent.id} profile={agent.profile} />
                <span className="truncate">{agent.name}</span>
            </Link>
            <span className="min-w-0 text-sm break-words text-text-muted">{agent.profile.description}</span>
        </li>
    );
}
