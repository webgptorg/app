import { ShieldCheck } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { EngineActivityItem, engineActivitySummary } from './engine-activity';

export const securityFeature = defineFeature({
    id: 'security',
    requires: { permission: 'security.read' },
    nav: { group: 'admin', order: 20, label: m.nav_security, icon: ShieldCheck, to: '/security' },
    activityRenderers: [
        { kind: 'engine.*', versions: [1], component: EngineActivityItem, summary: engineActivitySummary },
    ],
});
