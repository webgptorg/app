import { createFileRoute } from '@tanstack/react-router';

import { TeamPage } from '../../../features/teams/team-page';

export const Route = createFileRoute('/_app/teams/$teamId')({
    component: function Team() {
        const { teamId } = Route.useParams();
        return <TeamPage key={teamId} teamId={teamId} />;
    },
});
