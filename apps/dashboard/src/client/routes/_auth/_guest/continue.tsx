import { createFileRoute } from '@tanstack/react-router';

import { ContinuePage } from '../../../features/auth/continue-page';
import { safeReturnTo } from '../../../features/session/return-to';

interface ContinueSearch {
    readonly returnTo?: string;
}

export const Route = createFileRoute('/_auth/_guest/continue')({
    validateSearch: (search: Readonly<Record<string, unknown>>): ContinueSearch => {
        const returnTo = safeReturnTo(search['returnTo']);
        return returnTo === undefined ? {} : { returnTo };
    },
    // Vetted again where it is used: TanStack merges this route's validated search over its parents' raw search, so
    // a rejected `returnTo` would otherwise still reach the component.
    component: function Continue() {
        return <ContinuePage returnTo={safeReturnTo(Route.useSearch().returnTo)} />;
    },
});
