import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';

import { AGENT_TABS, defineFeature } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

/**
 * The agent's Book tab (U-04): every member who may read agents sees the book and its history; saving and restoring
 * need `agents.write`, which the page checks per action. Agent Settings points here for the name and description.
 * Only an engine that lets the UI edit Books (`book-editor@1`) has the tab.
 */
export const bookFeature = defineFeature({
    id: 'book',
    requires: { capability: KNOWN_CAPABILITIES.bookEditor, permission: 'agents.read' },
    agentTabs: [{ ...AGENT_TABS.book, label: m.agent_tab_book, to: '/agents/$agentId/book' }],
});
