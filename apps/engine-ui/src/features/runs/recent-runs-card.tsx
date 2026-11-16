import type { AgentId } from '@ptbk/engine-api';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import {
    OverviewFailed,
    OverviewLoading,
    OverviewRow,
    OverviewRows,
    OverviewSection,
    overviewLinkClassName,
} from '../agents/overview-parts';
import { EntityChip } from '../entities/entity-chip';
import { runTitle } from './run-format';
import { RunStatusBadge } from './run-status';
import { runListQueryOptions } from './runs-queries';

const RECENT = 5;

/** The agent overview's last five runs as rows, and the way to all of them; nothing before its first run. */
export function RecentRunsCard({ agentId }: { readonly agentId: AgentId }) {
    const runs = useQuery(runListQueryOptions(useEngineApi(), { agentId, limit: RECENT }));
    if (runs.isSuccess && runs.data.items.length === 0) return null;
    return (
        <OverviewSection
            title={m.runs_recent_title()}
            all={
                <Link
                    to="/agents/$agentId/runs"
                    params={{ agentId }}
                    variant="standalone"
                    className={overviewLinkClassName}
                >
                    {m.runs_recent_all()}
                </Link>
            }
        >
            {runs.isPending ? (
                <OverviewLoading label={m.runs_recent_title()} rows={RECENT} />
            ) : runs.isError ? (
                <OverviewFailed
                    message={m.runs_load_failed()}
                    onRetry={() => {
                        void runs.refetch();
                    }}
                    retrying={runs.isFetching}
                />
            ) : (
                <OverviewRows>
                    {runs.data.items.map((run) => (
                        <OverviewRow key={run.id} lead={<Activity aria-hidden />} at={run.queuedAt}>
                            <EntityChip kind="run" id={run.id} name={runTitle(run)} />
                            <RunStatusBadge status={run.status} cancelling={run.cancelRequestedAt !== null} />
                        </OverviewRow>
                    ))}
                </OverviewRows>
            )}
        </OverviewSection>
    );
}
