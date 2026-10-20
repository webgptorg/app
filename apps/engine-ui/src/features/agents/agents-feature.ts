import { Bot } from 'lucide-react';

import { defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

export const agentsFeature = defineFeature({
    id: 'agents',
    requires: { permission: 'agents.read' },
    nav: { group: 'work', order: 20, label: m.nav_agents, icon: Bot, to: '/agents' },
});
