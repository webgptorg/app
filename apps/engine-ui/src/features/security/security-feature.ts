import { ShieldCheck } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { EngineActivityItem, engineActivitySummary } from './engine-activity';

export const securityFeature = defineFeature({
    id: 'security',
    // Every member verifies the engine's identity and manages their own passkeys; the engine's reported claims inside
    // need `security.read`.
    requires: {},
    nav: { group: 'admin', order: 20, label: m.nav_security, icon: ShieldCheck, to: '/security' },
    commands: [
        {
            id: 'security.passkeys',
            label: m.passkeys_title,
            keywords: () => [m.nav_security(), m.security_access_title()],
            to: '/security/passkeys',
        },
    ],
    activityRenderers: [
        { kind: 'engine.*', versions: [1], component: EngineActivityItem, summary: engineActivitySummary },
    ],
});
