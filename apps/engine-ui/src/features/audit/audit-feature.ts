import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { ScrollText } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

export const auditFeature = defineFeature({
    id: 'audit',
    requires: { capability: KNOWN_CAPABILITIES.audit, permission: 'audit.read' },
    nav: { group: 'admin', order: 40, label: m.nav_audit, icon: ScrollText, to: '/audit' },
});
