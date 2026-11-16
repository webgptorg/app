import type { AgentId } from '@ptbk/engine-api';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ListTodo } from 'lucide-react';

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
import { splitTaskName } from './task-name';
import { TaskStateBadge } from './task-state';
import { taskListQueryOptions } from './tasks-queries';

const SHOWN = 5;

/** The agent overview's tasks, in the engine's own order (what needs a decision first); nothing when it has none. */
export function AgentTasksCard({ agentId }: { readonly agentId: AgentId }) {
    const list = useInfiniteQuery(taskListQueryOptions(useEngineApi(), { agentId, limit: SHOWN }));
    const tasks = list.data?.pages[0]?.items ?? [];
    if (list.isSuccess && tasks.length === 0) return null;
    return (
        <OverviewSection
            title={m.agent_overview_tasks()}
            all={
                <Link to="/tasks" search={{ agentId }} variant="standalone" className={overviewLinkClassName}>
                    {m.agent_overview_all_tasks()}
                </Link>
            }
        >
            {list.isPending ? (
                <OverviewLoading label={m.agent_overview_tasks()} />
            ) : list.isError ? (
                <OverviewFailed
                    message={m.tasks_load_failed()}
                    onRetry={() => {
                        void list.refetch();
                    }}
                    retrying={list.isFetching}
                />
            ) : (
                <OverviewRows>
                    {tasks.map((task) => (
                        <OverviewRow key={task.id} lead={<ListTodo aria-hidden />} at={task.updatedAt}>
                            <EntityChip kind="task" id={task.id} name={splitTaskName(task.name).readable} />
                            <TaskStateBadge state={task.state} />
                        </OverviewRow>
                    ))}
                </OverviewRows>
            )}
        </OverviewSection>
    );
}
