import { createFileRoute } from '@tanstack/react-router';

import { PeoplePage } from '../../features/teams/people-page';

export const Route = createFileRoute('/_app/people')({
    component: PeoplePage,
});
