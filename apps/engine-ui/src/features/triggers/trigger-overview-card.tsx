import type { AgentId, TriggerStats } from '@ptbk/engine-api';
import { Card, ErrorState, Skeleton } from '@ptbk/ui';
import { Fragment } from 'react';
import type { ReactNode } from 'react';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { RelativeFireTime } from './trigger-time';
import { useTriggerStats } from './triggers-queries';

/**
 * The agent overview's card, as one sentence: "1 active · next run in 6 days · 1 paused". A failed trigger links to
 * the filtered tab, where it can be resumed.
 */
export function TriggerOverviewCard({ agentId }: { readonly agentId: AgentId }) {
    const stats = useTriggerStats(agentId);
    return (
        <Card
            title={m.triggers_card_title()}
            actions={
                <Link to="/agents/$agentId/triggers" params={{ agentId }}>
                    {m.triggers_card_all()}
                </Link>
            }
        >
            {stats.isPending ? (
                <div aria-busy="true" aria-label={m.triggers_card_title()}>
                    <Skeleton shape="text" className="h-5 w-2/3" />
                </div>
            ) : stats.isError ? (
                <ErrorState
                    message={m.triggers_load_failed()}
                    onRetry={() => {
                        void stats.refetch();
                    }}
                    retrying={stats.isFetching}
                />
            ) : (
                <TriggerStatsLine agentId={agentId} stats={stats.data} />
            )}
        </Card>
    );
}

function TriggerStatsLine({ agentId, stats }: { readonly agentId: AgentId; readonly stats: TriggerStats }) {
    if (stats.active + stats.paused + stats.failed === 0) {
        return <p className="text-sm text-text-muted">{m.triggers_card_none()}</p>;
    }
    const parts: ReactNode[] = [<span key="active">{m.triggers_card_active_count({ count: stats.active })}</span>];
    if (stats.nextFireAt !== null) {
        parts.push(
            <span key="next">
                {m.triggers_card_next_run()} <RelativeFireTime at={stats.nextFireAt} empty={m.trigger_value_none()} />
            </span>,
        );
    }
    if (stats.paused > 0) {
        parts.push(<span key="paused">{m.triggers_card_paused_count({ count: stats.paused })}</span>);
    }
    if (stats.failed > 0) {
        parts.push(
            <Link key="failed" to="/agents/$agentId/triggers" params={{ agentId }} search={{ lifecycle: 'failed' }}>
                {m.triggers_card_failed_count({ count: stats.failed })}
            </Link>,
        );
    }
    return (
        <p className="text-sm">
            {parts.map((part, index) => (
                <Fragment key={index}>
                    {index === 0 ? null : <span className="text-text-muted"> · </span>}
                    {part}
                </Fragment>
            ))}
        </p>
    );
}
