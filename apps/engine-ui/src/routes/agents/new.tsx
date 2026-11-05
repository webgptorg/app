import { createFileRoute } from '@tanstack/react-router';

import { AgentWizardPage } from '../../features/agent-wizard/agent-wizard-page';
import { WizardSearch } from '../../features/agent-wizard/wizard-search';
import { requireFeature } from '../../app/registry/require-feature';

export const Route = createFileRoute('/agents/new')({
    beforeLoad: requireFeature('agent-wizard'),
    validateSearch: WizardSearch,
    component: AgentWizardPage,
});
