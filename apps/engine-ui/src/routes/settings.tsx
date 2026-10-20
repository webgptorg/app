import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { SettingsPage } from '../features/settings/settings-page';

// Language and theme now; U-06 adds the engine settings and the update policy.
export const Route = createFileRoute('/settings')({
    beforeLoad: requireFeature('settings'),
    component: SettingsPage,
});
