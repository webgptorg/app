import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { SessionsPage } from '../../features/security/sessions-page';

export const Route = createFileRoute('/security_/sessions')({
    beforeLoad: requireFeature('security'),
    component: SessionsPage,
});
