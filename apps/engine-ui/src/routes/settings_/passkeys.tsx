import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { PasskeysPage } from '../../features/security/passkeys-page';

// Every member manages their own passkeys (`/me/passkeys` needs no permission), so this sits under settings, which
// every member can open, rather than under the security panel.
export const Route = createFileRoute('/settings_/passkeys')({
    beforeLoad: requireFeature('settings'),
    component: PasskeysPage,
});
