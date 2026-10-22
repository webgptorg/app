import { createFileRoute } from '@tanstack/react-router';

import { AgentWizardPage } from '../../features/agent-wizard/agent-wizard-page';
import { WizardSearch } from '../../features/agent-wizard/wizard-search';
import { requirePermission } from '../../features/session/require-permission';

export const Route = createFileRoute('/agents/new')({
    beforeLoad: requirePermission('agents.write'),
    validateSearch: WizardSearch,
    component: AgentWizardPage,
});
