import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../../app/registry/require-feature';
import { AgentFilesPage } from '../../../features/files/agent-files-page';
import { AgentFilesSearch } from '../../../features/files/files-search';

export const Route = createFileRoute('/agents/$agentId/files')({
    beforeLoad: requireFeature('files', { agentTab: 'files' }),
    validateSearch: AgentFilesSearch,
    component: AgentFilesPage,
});
