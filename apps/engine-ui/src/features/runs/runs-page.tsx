import { getRouteApi } from '@tanstack/react-router';
import { useCallback } from 'react';

import { m } from '../../paraglide/messages';
import { Page } from '../shell/page';
import type { RunSearch } from './run-search';
import { RunsTable } from './runs-table';

const route = getRouteApi('/runs/');

/** Every run on the engine, across agents, newest first. */
export function RunsPage() {
    const search = route.useSearch();
    const navigate = route.useNavigate();
    const onSearchChange = useCallback(
        (change: Partial<RunSearch>, options: { readonly replace?: boolean } = {}) => {
            void navigate({ search: (previous) => ({ ...previous, ...change }), replace: options.replace ?? false });
        },
        [navigate],
    );
    return (
        <Page title={m.runs_title()} description={m.runs_intro()}>
            <RunsTable search={search} onSearchChange={onSearchChange} />
        </Page>
    );
}
