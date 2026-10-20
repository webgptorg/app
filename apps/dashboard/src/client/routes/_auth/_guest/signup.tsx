import { createFileRoute } from '@tanstack/react-router';

import { SignUpPage } from '../../../features/auth/signup-page';
import { takeFragment } from '../../../features/auth/take-fragment';
import { useFragmentToken, useFragmentArrivals } from '../../../features/auth/use-fragment-token';

export const Route = createFileRoute('/_auth/_guest/signup')({
    beforeLoad: ({ context, location }) => {
        takeFragment(context, location, 'signup', '/signup');
    },
    component: function SignUp() {
        return <SignUpPageEntry key={useFragmentArrivals()} />;
    },
});

function SignUpPageEntry() {
    return <SignUpPage initialToken={useFragmentToken('signup')} />;
}
