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
    component: function SignIn() {
        return <SignInPage returnTo={Route.useSearch().returnTo} />;
    },
});
