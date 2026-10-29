import { KeyRound } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { useSecretPaletteResults } from './secret-palette-search';

export const secretsFeature = defineFeature({
    id: 'secrets',
    requires: { permission: 'secrets.read' },
    nav: { group: 'admin', order: 30, label: m.nav_secrets, icon: KeyRound, to: '/secrets' },
    commands: [
        {
            id: 'secrets.new',
            label: m.secrets_new,
            keywords: () => [m.nav_secrets()],
            to: '/secrets',
            search: { dialog: 'new' },
            requires: { permission: 'secrets.manage' },
        },
    ],
    paletteSearch: { id: 'secrets', label: m.nav_secrets, useResults: useSecretPaletteResults },
});
