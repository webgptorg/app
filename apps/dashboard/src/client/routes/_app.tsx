import { createFileRoute } from '@tanstack/react-router';

import { requireSession } from '../features/session/session-guards';
import { AppShell } from '../features/shell/app-shell';

/** The signed-in area: without a session, every route below redirects to `/continue` and comes back afterwards. */
export const Route = createFileRoute('/_app')({
    beforeLoad: ({ context, location }) => requireSession(context, location),
    component: AppShell,
});
