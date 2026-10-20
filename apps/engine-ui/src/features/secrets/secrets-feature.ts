import { KeyRound } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

export const secretsFeature = defineFeature({
    id: 'secrets',
    requires: { permission: 'secrets.read' },
    nav: { group: 'admin', order: 30, label: m.nav_secrets, icon: KeyRound, to: '/secrets' },
});
