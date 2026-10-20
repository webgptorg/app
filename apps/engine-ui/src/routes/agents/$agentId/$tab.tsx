import { createFileRoute } from '@tanstack/react-router';

import { resolveUnservedAgentTab } from '../../../app/registry/agent-tab-access';
import { RouteNotFound } from '../../../app/route-states';

// A registered tab whose feature has not shipped its route yet, or a mistyped one; real tab routes match first.
export const Route = createFileRoute('/agents/$agentId/$tab')({
    beforeLoad: ({ context, params }) => resolveUnservedAgentTab(context, params.tab),
    notFoundComponent: RouteNotFound,
});
