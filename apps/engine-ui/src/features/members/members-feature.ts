import { Users } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { MemberActivityItem, memberActivitySummary } from './member-activity';

export const membersFeature = defineFeature({
    id: 'members',
    requires: { permission: 'members.read' },
    nav: { group: 'admin', order: 10, label: m.nav_members, icon: Users, to: '/members' },
    activityRenderers: [
        { kind: 'member.*', versions: [1], component: MemberActivityItem, summary: memberActivitySummary },
    ],
});
