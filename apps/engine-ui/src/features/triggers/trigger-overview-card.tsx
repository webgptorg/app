import type { AgentId } from '@ptbk/engine-api';
import { Card, ErrorState, Skeleton } from '@ptbk/ui';

import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { FireTime } from './trigger-time';
import { useTriggerStats } from './triggers-queries';

/** The agent overview's card: how many triggers run, when the next one fires, and what is paused or failed. */
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
                <div aria-busy="true" aria-label={m.triggers_card_title()} className="flex flex-col gap-2">
                    <Skeleton shape="text" className="h-6 w-full" />
                    <Skeleton shape="text" className="h-6 w-2/3" />
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
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <dt className="text-text-muted">{m.triggers_card_active()}</dt>
                    <dd>{stats.data.active}</dd>
                    <dt className="text-text-muted">{m.triggers_card_next()}</dt>
                    <dd>
                        <FireTime at={stats.data.nextFireAt} countdown />
                    </dd>
                    <dt className="text-text-muted">{m.triggers_card_paused()}</dt>
                    <dd>{stats.data.paused}</dd>
                    <dt className="text-text-muted">{m.triggers_card_failed()}</dt>
                    <dd>
                        {stats.data.failed === 0 ? (
                            0
                        ) : (
                            <Link to="/agents/$agentId/triggers" params={{ agentId }} search={{ lifecycle: 'failed' }}>
                                {stats.data.failed}
                            </Link>
                        )}
                    </dd>
                </dl>
            )}
        </Card>
    );
}
