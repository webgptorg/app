import type { AgentId, TriggerStats } from '@ptbk/engine-api';
import { Fragment } from 'react';
import type { ReactNode } from 'react';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { OverviewFailed, OverviewLoading, OverviewSection, overviewLinkClassName } from '../agents/overview-parts';
import { RelativeFireTime } from './trigger-time';
import { useTriggerStats } from './triggers-queries';

/**
 * The agent overview's triggers, as one sentence: "1 active · next run in 6 days · 1 paused". A failed trigger links to
 * the filtered tab, where it can be resumed. An agent without triggers has no section.
 */
export function TriggerOverviewCard({ agentId }: { readonly agentId: AgentId }) {
    const stats = useTriggerStats(agentId);
    if (stats.isSuccess && stats.data.active + stats.data.paused + stats.data.failed === 0) return null;
    return (
        <OverviewSection
            title={m.triggers_card_title()}
            all={
                <Link
                    to="/agents/$agentId/triggers"
                    params={{ agentId }}
                    variant="standalone"
                    className={overviewLinkClassName}
                >
                    {m.triggers_card_all()}
                </Link>
            }
        >
            {stats.isPending ? (
                <OverviewLoading label={m.triggers_card_title()} rows={1} />
            ) : stats.isError ? (
                <OverviewFailed
                    message={m.triggers_load_failed()}
                    onRetry={() => {
                        void stats.refetch();
                    }}
                    retrying={stats.isFetching}
                />
            ) : (
                <TriggerStatsLine agentId={agentId} stats={stats.data} />
            )}
        </OverviewSection>
    );
}

function TriggerStatsLine({ agentId, stats }: { readonly agentId: AgentId; readonly stats: TriggerStats }) {
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
            <Link
                key="failed"
                to="/agents/$agentId/triggers"
                params={{ agentId }}
                search={{ lifecycle: 'failed' }}
                variant="standalone"
                className="font-medium text-danger"
            >
                {m.triggers_card_failed_count({ count: stats.failed })}
            </Link>,
        );
    }
    return (
        <p className="text-sm tabular-nums">
            {parts.map((part, index) => (
                <Fragment key={index}>
                    {index === 0 ? null : <span className="text-text-muted"> · </span>}
                    {part}
                </Fragment>
            ))}
        </p>
    );
}
