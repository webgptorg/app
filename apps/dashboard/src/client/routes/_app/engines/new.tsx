import { createFileRoute } from '@tanstack/react-router';

import { NewEnginePage, type NewEngineSearch } from '../../../features/engines/new-engine-page';

const LINK_CODE_ID = /^[a-z2-7]{26}$/;

/** `link` is a link code's ID from issuance; `checkout` is set by the Checkout return URLs. Anything else is dropped. */
function newEngineSearch(search: Readonly<Record<string, unknown>>): NewEngineSearch {
    const { link, checkout } = search;
    return {
        ...(typeof link === 'string' && LINK_CODE_ID.test(link) ? { link } : {}),
        ...(checkout === 'success' || checkout === 'cancel' ? { checkout } : {}),
    };
}

export const Route = createFileRoute('/_app/engines/new')({
    validateSearch: newEngineSearch,
    component: function NewEngine() {
        // Parsed again: the root route has no schema, so raw search values reach the merged search too.
        return <NewEnginePage search={newEngineSearch(Route.useSearch())} />;
    },
});
