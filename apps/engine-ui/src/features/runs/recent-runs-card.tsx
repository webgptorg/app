import type { AgentId, ReadRun } from '@ptbk/engine-api';
import { Card, ErrorState, RelativeTime, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { runTitle } from './run-format';
import { RunStatusBadge } from './run-status';
import { runListQueryOptions } from './runs-queries';

const RECENT = 5;

/** The agent overview's card: its last five runs, and the way to all of them. */
export function RecentRunsCard({ agentId }: { readonly agentId: AgentId }) {
    const runs = useQuery(runListQueryOptions(useEngineApi(), { agentId, limit: RECENT }));
    return (
        <Card
            title={m.runs_recent_title()}
            actions={
                <Link to="/agents/$agentId/runs" params={{ agentId }}>
                    {m.runs_recent_all()}
                </Link>
            }
        >
            {runs.isPending ? (
                <ul aria-busy="true" aria-label={m.runs_recent_title()} className="flex flex-col gap-2">
                    {Array.from({ length: RECENT }, (_, index) => (
                        <li key={index}>
                            <Skeleton shape="text" className="h-6 w-full" />
                        </li>
                    ))}
                </ul>
            ) : runs.isError ? (
                <ErrorState
                    message={m.runs_load_failed()}
                    onRetry={() => {
                        void runs.refetch();
                    }}
                    retrying={runs.isFetching}
                />
            ) : runs.data.items.length === 0 ? (
                <p className="text-sm text-text-muted">{m.runs_empty_title()}</p>
            ) : (
                <ul className="flex flex-col divide-y divide-divider">
                    {runs.data.items.map((run) => (
                        <RecentRun key={run.id} run={run} />
                    ))}
                </ul>
            )}
        </Card>
    );
}

function RecentRun({ run }: { readonly run: ReadRun }) {
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <RunStatusBadge status={run.status} cancelling={run.cancelRequestedAt !== null} />
            <Link to="/runs/$runId" params={{ runId: run.id }} className="min-w-0 flex-1 break-words">
                {runTitle(run)}
            </Link>
            <RelativeTime value={new Date(run.queuedAt)} className="text-sm text-text-muted" />
        </li>
    );
}
