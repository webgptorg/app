import { createFileRoute } from '@tanstack/react-router';

import { SignInPage } from '../../../features/auth/signin-page';
import { safeReturnTo } from '../../../features/session/return-to';

interface SignInSearch {
    readonly returnTo?: string;
}

export const Route = createFileRoute('/_auth/_guest/signin')({
    validateSearch: (search: Readonly<Record<string, unknown>>): SignInSearch => {
        const returnTo = safeReturnTo(search['returnTo']);
        return returnTo === undefined ? {} : { returnTo };
    },
    // Vetted again where it is used: TanStack merges this route's validated search over its parents' raw search, so
    // a rejected `returnTo` would otherwise still reach the component.
    component: function SignIn() {
        return <SignInPage returnTo={safeReturnTo(Route.useSearch().returnTo)} />;
    },
});
