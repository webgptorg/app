import { Bot } from 'lucide-react';

import { AGENT_TABS, defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

/**
 * Agents: the list, the agent page frame and its Overview and Settings tabs. Other features add tabs and overview
 * cards through their own definitions (U-04 Book, U-05 Chat, U-09 to U-12 Runs, Files, Triggers, Integrations).
 */
export const agentsFeature = defineFeature({
    id: 'agents',
    requires: { permission: 'agents.read' },
    nav: { group: 'work', order: 20, label: m.nav_agents, icon: Bot, to: '/agents' },
    agentTabs: [
        { ...AGENT_TABS.overview, label: m.agent_tab_overview, to: '/agents/$agentId' },
        {
            ...AGENT_TABS.settings,
            label: m.agent_tab_settings,
            to: '/agents/$agentId/settings',
            requires: {
                anyPermission: ['agents.write', 'agents.delete'],
            },
        },
    ],
    commands: [{ id: 'agents.open', label: m.command_go_to_agent, keywords: () => [m.nav_agents()], to: '/agents' }],
});
