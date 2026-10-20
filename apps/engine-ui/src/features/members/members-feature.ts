import { Users } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

export const membersFeature = defineFeature({
    id: 'members',
    requires: { permission: 'members.read' },
    nav: { group: 'admin', order: 10, label: m.nav_members, icon: Users, to: '/members' },
});
