import { AGENT_TABS, defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

/** Chat: the agent's Chat tab, with its chat list and the chats themselves (U-05). */
export const chatFeature = defineFeature({
    id: 'chat',
    requires: { permission: 'chats.read' },
    agentTabs: [{ ...AGENT_TABS.chat, label: m.agent_tab_chat, to: '/agents/$agentId/chat' }],
});
