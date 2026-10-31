import { createFileRoute } from '@tanstack/react-router';

import { TeamListPage } from '../../../features/teams/team-list-page';

export const Route = createFileRoute('/_app/teams/')({
    component: TeamListPage,
});
