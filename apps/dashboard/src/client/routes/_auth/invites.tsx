import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';

import { takeFragment } from '../../features/auth/take-fragment';
import { useFragmentArrivals } from '../../features/auth/use-fragment-token';
import { InvitePage } from '../../features/teams/invite-page';

/** Open signed in or not: the page itself signs in or creates the account, and joins, without leaving (D-31). */
export const Route = createFileRoute('/_auth/invites')({
    beforeLoad: ({ context, location }) => {
        takeFragment(context, location, 'invite', '/invites');
    },
    component: function Invites() {
        return <InvitePageEntry key={useFragmentArrivals()} />;
    },
});

// Peeks without forgetting, unlike signup and recovery: the page may remount (a sign-out here) and still needs it.
// Joining forgets it; a reload falls back to the server's invitation cookie.
function InvitePageEntry() {
    const { fragmentTokens } = useRouter().options.context;
    const [token] = useState(() => fragmentTokens.peek('invite'));
    return <InvitePage token={token} />;
}
