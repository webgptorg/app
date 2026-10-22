import { TriggerId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../../app/registry/require-feature';
import { requirePermission } from '../../../features/session/require-permission';
import { EditTriggerPage } from '../../../features/triggers/trigger-form-pages';
import { triggerQueryOptions } from '../../../features/triggers/triggers-queries';

export const Route = createFileRoute('/triggers/$triggerId/edit')({
    beforeLoad: async (options) => {
        await requireFeature('triggers')(options);
        await requirePermission('triggers.manage')(options);
    },
    loader: ({ context, params }) => {
        const triggerId = TriggerId.safeParse(params.triggerId).data;
        if (triggerId === undefined) return;
        context.queryClient.query(triggerQueryOptions(context.engineApi, triggerId)).catch(() => undefined);
    },
    component: EditTriggerPage,
});
