import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';

import { takeFragment } from '../../features/auth/take-fragment';
import { useFragmentArrivals } from '../../features/auth/use-fragment-token';
import { InvitePage } from '../../features/teams/invite-page';

/** Open signed in or not: the page itself says to sign in, and a sign-in in this tab returns here. */
export const Route = createFileRoute('/_auth/invites')({
    beforeLoad: ({ context, location }) => {
        takeFragment(context, location, 'invite', '/invites');
    },
    component: function Invites() {
        return <InvitePageEntry key={useFragmentArrivals()} />;
    },
});

// Peeks without forgetting, unlike signup and recovery: the token must outlive a sign-in in this tab. Accepting
// forgets it.
function InvitePageEntry() {
    const { fragmentTokens } = useRouter().options.context;
    const [token] = useState(() => fragmentTokens.peek('invite'));
    return <InvitePage token={token} />;
}
