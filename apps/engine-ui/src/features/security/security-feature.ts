import { ShieldCheck } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

export const securityFeature = defineFeature({
    id: 'security',
    requires: { permission: 'security.read' },
    nav: { group: 'admin', order: 20, label: m.nav_security, icon: ShieldCheck, to: '/security' },
});
