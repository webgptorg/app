import { createFileRoute } from '@tanstack/react-router';

import { NewEnginePage, parseNewEngineSearch, type NewEngineSearch } from '../../../features/engines/new-engine-page';

export const Route = createFileRoute('/_app/engines/new')({
    // Only types the search here: the component parses it, so the parser loads with the page, not with the entry.
    validateSearch: (search: Readonly<Record<string, unknown>>) => search as NewEngineSearch,
    component: function NewEngine() {
        return <NewEnginePage search={parseNewEngineSearch(Route.useSearch())} />;
    },
});
