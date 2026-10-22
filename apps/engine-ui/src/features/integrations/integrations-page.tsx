import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';

import { m } from '../../paraglide/messages';
import { Page } from '../shell/page';
import { AddIntegrationActions } from './add-integration-actions';
import type { IntegrationSearch } from './integration-search';
import { IntegrationsTable } from './integrations-table';

const route = getRouteApi('/integrations/');

/** Everything agents may reach outside the engine: MCP servers, calendars and repositories, newest first. */
export function IntegrationsPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const onSearchChange = useCallback(
        (change: Partial<IntegrationSearch>, options: { readonly replace?: boolean } = {}) => {
            void navigate({ search: (previous) => ({ ...previous, ...change }), replace: options.replace ?? false });
        },
        [navigate],
    );
    return (
        <Page title={m.integrations_title()} actions={<AddIntegrationActions />}>
            <p className="text-sm text-text-muted">{m.integrations_intro()}</p>
            <IntegrationsTable search={search} onSearchChange={onSearchChange} />
        </Page>
    );
}
