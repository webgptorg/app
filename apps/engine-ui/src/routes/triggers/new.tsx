import { AgentId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { requireFeature } from '../../app/registry/require-feature';
import { requirePermission } from '../../features/session/require-permission';
import { NewTriggerPage } from '../../features/triggers/trigger-form-pages';

export const Route = createFileRoute('/triggers/new')({
    beforeLoad: async (options) => {
        await requireFeature('triggers')(options);
        await requirePermission('triggers.manage')(options);
    },
    validateSearch: z.object({ agentId: AgentId.optional().catch(undefined) }),
    component: NewTriggerPage,
});
