import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';

import { defineFeature } from '../../app/registry/feature';
import type { FeatureRequirement } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

/** Creating an agent from a form; an engine without `agent-management@1` creates agents through chat instead. */
export const AGENT_WIZARD_REQUIREMENT: FeatureRequirement = {
    capability: KNOWN_CAPABILITIES.agentManagement,
    permission: 'agents.write',
};

export const agentWizardFeature = defineFeature({
    id: 'agent-wizard',
    requires: AGENT_WIZARD_REQUIREMENT,
    commands: [{ id: 'agents.new', label: m.agents_new, keywords: () => [m.nav_agents()], to: '/agents/new' }],
});
