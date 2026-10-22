import { AgentId } from '@ptbk/engine-api';
import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../../app/registry/require-feature';
import { BookEditorPage } from '../../../features/book/book-editor-page';
import { agentSourceQueryOptions } from '../../../features/book/book-queries';

export const Route = createFileRoute('/agents/$agentId/book')({
    beforeLoad: requireFeature('book', { agentTab: 'book' }),
    loader: ({ context, params }) => {
        const agentId = AgentId.safeParse(params.agentId).data;
        if (agentId === undefined) return;
        // Started here so the text loads alongside the editor's code; the page shows its own loading and error states.
        context.queryClient.query(agentSourceQueryOptions(context.engineApi, agentId)).catch(() => undefined);
    },
    component: BookEditorPage,
});
