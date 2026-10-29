import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { PasskeysPage } from '../../features/security/passkeys-page';

// Every member manages their own passkeys (`/me/passkeys` needs no permission), as Security is every member's page.
export const Route = createFileRoute('/security_/passkeys')({
    beforeLoad: requireFeature('security'),
    component: PasskeysPage,
});
