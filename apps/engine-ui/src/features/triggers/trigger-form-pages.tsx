import { TriggerId } from '@ptbk/engine-api';
import { ErrorState, Skeleton } from '@ptbk/ui';
import { getRouteApi } from '@tanstack/react-router';

import { m } from '../../paraglide/messages';
import { Page } from '../shell/page';
import { TriggerBackLink, TriggerListBackLink } from './trigger-back-link';
import { TriggerForm } from './trigger-form';
import { useTrigger } from './triggers-queries';

const newRoute = getRouteApi('/triggers/new');
const editRoute = getRouteApi('/triggers/$triggerId/edit');

export function NewTriggerPage() {
    const { agentId } = newRoute.useSearch();
    return (
        <Page title={m.trigger_new_title()} back={<TriggerListBackLink agentId={agentId} />}>
            <TriggerForm {...(agentId === undefined ? {} : { agentId })} />
        </Page>
    );
}

export function EditTriggerPage() {
    const triggerId = TriggerId.safeParse(editRoute.useParams().triggerId).data;
    if (triggerId === undefined) {
        return (
            <Page title={m.trigger_not_found_title()} back={<TriggerListBackLink />}>
                <p>{m.trigger_not_found_body()}</p>
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
            <Page title={m.trigger_edit_title()}>
                <Skeleton shape="block" className="h-96 w-full max-w-2xl" />
            </Page>
        );
    }
    if (trigger.isError) {
        return (
            <Page title={m.trigger_edit_title()}>
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
            title={m.trigger_edit_named({ name: trigger.data.name })}
            back={<TriggerBackLink triggerId={triggerId} name={trigger.data.name} fromAgent={fromAgent} />}
        >
            <TriggerForm trigger={trigger.data} fromAgent={fromAgent} />
        </Page>
    );
}
