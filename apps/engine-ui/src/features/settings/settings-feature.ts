import { Settings } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

export const settingsFeature = defineFeature({
    id: 'settings',
    // Everyone may set their own language and theme; the update policy inside needs `security.read` to show.
    requires: {},
    nav: { group: 'admin', order: 50, label: m.nav_settings, icon: Settings, to: '/settings' },
    commands: [
        {
            id: 'settings.updates',
            label: m.security_policy_title,
            keywords: () => [m.nav_settings(), m.settings_updates()],
            requires: { permission: 'security.read' },
            to: '/settings',
        },
    ],
});
