import { TriggerId } from '@ptbk/engine-api';
import type { AgentId } from '@ptbk/engine-api';
import { EmptyState, ErrorState, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { agentDetailQueryOptions } from '../agents/agents-queries';
import { Page } from '../shell/page';
import { TriggerForm } from './trigger-form';
import { TriggerCrumb, triggerTrail, TriggersCrumb } from './trigger-trail';
import { useTrigger } from './triggers-queries';

const newRoute = getRouteApi('/triggers/new');
const editRoute = getRouteApi('/triggers/$triggerId/edit');

export function NewTriggerPage() {
    const { agentId } = newRoute.useSearch();
    return agentId === undefined ? (
        <NewTrigger breadcrumbs={triggerTrail(undefined)} />
    ) : (
        <NewAgentTrigger agentId={agentId} />
    );
}

/** From an agent's tab the trail leads back there, by the agent's name once the engine answers. */
function NewAgentTrigger({ agentId }: { readonly agentId: AgentId }) {
    const agent = useQuery(agentDetailQueryOptions(useEngineApi(), agentId));
    return (
        <NewTrigger agentId={agentId} breadcrumbs={triggerTrail({ agentId, agentName: agent.data?.name ?? null })} />
    );
}

function NewTrigger({ agentId, breadcrumbs }: { readonly agentId?: AgentId; readonly breadcrumbs: ReactNode[] }) {
    return (
        <Page title={m.trigger_new_title()} breadcrumbs={breadcrumbs}>
            <TriggerForm {...(agentId === undefined ? {} : { agentId })} />
        </Page>
    );
}

export function EditTriggerPage() {
    const triggerId = TriggerId.safeParse(editRoute.useParams().triggerId).data;
    if (triggerId === undefined) {
        return (
            <Page title={m.trigger_not_found_title()} breadcrumbs={[<TriggersCrumb key="triggers" />]}>
                <EmptyState title={m.trigger_not_found_title()} description={m.trigger_not_found_body()} />
            </Page>
        );
    }
    return <LoadedEdit triggerId={triggerId} />;
}

function LoadedEdit({ triggerId }: { readonly triggerId: TriggerId }) {
    const trigger = useTrigger(triggerId);
    const fromAgent = editRoute.useSearch().from === 'agent';
    if (trigger.isPending) {
        return (
            <Page title={m.trigger_edit_title()} breadcrumbs={[<TriggersCrumb key="triggers" />]}>
                <Skeleton shape="block" className="h-96 w-full max-w-2xl" />
            </Page>
        );
    }
    if (trigger.isError) {
        return (
            <Page title={m.trigger_edit_title()} breadcrumbs={[<TriggersCrumb key="triggers" />]}>
                <ErrorState
                    message={m.trigger_load_failed()}
                    onRetry={() => {
                        void trigger.refetch();
                    }}
                    retrying={trigger.isFetching}
                />
            </Page>
        );
    }
    return (
        <Page
            title={m.trigger_edit_title()}
            documentTitle={[m.trigger_edit_title(), trigger.data.name]}
            breadcrumbs={[
                ...triggerTrail(fromAgent ? trigger.data : undefined),
                <TriggerCrumb key="trigger" trigger={trigger.data} fromAgent={fromAgent} />,
            ]}
        >
            <TriggerForm trigger={trigger.data} fromAgent={fromAgent} />
        </Page>
    );
}
