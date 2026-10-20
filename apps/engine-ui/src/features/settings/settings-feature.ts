import { Settings } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

export const settingsFeature = defineFeature({
    id: 'settings',
    // Everyone may set their own language and theme; engine settings inside need `settings.manage` (U-06).
    requires: {},
    nav: { group: 'admin', order: 50, label: m.nav_settings, icon: Settings, to: '/settings' },
});
