import { createFileRoute } from '@tanstack/react-router';

import { RecoverPage } from '../../features/auth/recover-page';
import { parseRecoverSearch } from '../../features/auth/recover-search';
import { takeFragment } from '../../features/auth/take-fragment';
import { useFragmentToken, useFragmentArrivals } from '../../features/auth/use-fragment-token';

/** Open whether signed in or not: someone who lost their passkeys may still have a session on another device. */
export const Route = createFileRoute('/_auth/recover')({
    validateSearch: parseRecoverSearch,
    beforeLoad: ({ context, location }) => {
        takeFragment(context, location, 'recovery', '/recover');
    },
    component: function Recover() {
        return <RecoverPageEntry key={useFragmentArrivals()} />;
    },
});

function RecoverPageEntry() {
    return <RecoverPage initialToken={useFragmentToken('recovery')} via={Route.useSearch().via ?? null} />;
}
