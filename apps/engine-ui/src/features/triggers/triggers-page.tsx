import type { AgentId } from '@ptbk/engine-api';
import { getRouteApi } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useCallback } from 'react';

import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { Can } from '../session/use-permissions';
import { Page } from '../shell/page';
import type { TriggerSearch } from './trigger-search';
import { TriggersTable } from './triggers-table';

const route = getRouteApi('/triggers/');

/** What starts agents without a chat: inbound email addresses and schedules, across agents. */
export function TriggersPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const onSearchChange = useCallback(
        (change: Partial<TriggerSearch>, options: { readonly replace?: boolean } = {}) => {
            void navigate({ search: (previous) => ({ ...previous, ...change }), replace: options.replace ?? false });
        },
        [navigate],
    );
    return (
        <Page title={m.triggers_title()} description={m.triggers_intro()} actions={<NewTriggerLink />}>
            <TriggersTable search={search} onSearchChange={onSearchChange} />
        </Page>
    );
}

export function NewTriggerLink({ agentId }: { readonly agentId?: AgentId }) {
    return (
        <Can permission="triggers.manage">
            <ButtonLink to="/triggers/new" search={agentId === undefined ? {} : { agentId }} variant="primary">
                <Plus aria-hidden className="size-4" />
                {m.trigger_new()}
            </ButtonLink>
        </Can>
    );
}
