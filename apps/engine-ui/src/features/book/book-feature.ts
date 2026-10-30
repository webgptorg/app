import { AGENT_TABS, defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

/**
 * The agent's Book tab (U-04): every member who may read agents sees the book and its history; saving and restoring
 * need `agents.write`, which the page checks per action. Agent Settings points here for the name and description.
 */
export const bookFeature = defineFeature({
    id: 'book',
    requires: { permission: 'agents.read' },
    agentTabs: [{ ...AGENT_TABS.book, label: m.agent_tab_book, to: '/agents/$agentId/book' }],
});
