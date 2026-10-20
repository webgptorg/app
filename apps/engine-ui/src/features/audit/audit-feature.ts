import { ScrollText } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

export const auditFeature = defineFeature({
    id: 'audit',
    requires: { permission: 'audit.read' },
    nav: { group: 'admin', order: 40, label: m.nav_audit, icon: ScrollText, to: '/audit' },
});
