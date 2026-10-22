import { House } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { useHomeEventSync } from './use-home-event-sync';

/** Home (U-08): every member has one; what it shows depends on their permissions and the engine's capabilities. */
export const homeFeature = defineFeature({
    id: 'home',
    requires: {},
    nav: { group: 'work', order: 0, label: m.nav_home, icon: House, to: '/' },
    eventSync: { useEventSync: useHomeEventSync },
});
