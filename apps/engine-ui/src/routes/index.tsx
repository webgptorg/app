import { createFileRoute, redirect } from '@tanstack/react-router';

import { firstNavPath } from '../app/registry/first-nav-path';

// Home (U-08) takes this route over; until then `/` opens the first section the member may use.
export const Route = createFileRoute('/')({
    beforeLoad: async ({ context }) => {
        redirect({ to: await firstNavPath(context), throw: true });
    },
});
