import { createFileRoute } from '@tanstack/react-router';

import { Joined } from '../../features/teams/invite-page';
import { parseJoinedSearch } from '../../features/teams/joined-search';

/** After accepting an offered invitation (D-33): on into its engines, as after joining from the link. */
export const Route = createFileRoute('/_auth/joined')({
    validateSearch: parseJoinedSearch,
    component: function JoinedRoute() {
        return <Joined teamIds={Route.useSearch().teams} />;
    },
});
