import { createFileRoute } from '@tanstack/react-router';

import { requirePermission } from '../../features/session/require-permission';
import { PageStub } from '../../features/shell/page-stub';
import { m } from '../../paraglide/messages';

// U-04 replaces this with the create-agent wizard.
export const Route = createFileRoute('/agents/new')({
    beforeLoad: requirePermission('agents.write'),
    component: () => <PageStub title={m.agents_new()} />,
});
