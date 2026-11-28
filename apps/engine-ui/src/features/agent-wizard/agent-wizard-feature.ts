import { defineFeature } from '../../app/registry/feature';
import type { FeatureRequirement } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';

/** Creating an agent is a core operation. Visibility, placement and restore need agent-management@1. */
export const AGENT_WIZARD_REQUIREMENT: FeatureRequirement = {
    permission: 'agents.write',
};

export const agentWizardFeature = defineFeature({
    id: 'agent-wizard',
    requires: AGENT_WIZARD_REQUIREMENT,
    commands: [{ id: 'agents.new', label: m.agents_new, keywords: () => [m.nav_agents()], to: '/agents/new' }],
});
