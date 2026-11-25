import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { requireFeature } from '../../app/registry/require-feature';
import { AiToolsPage } from '../../features/ai-tools/ai-tools-page';
import { aiToolsQueryOptions } from '../../features/ai-tools/ai-tools-queries';

/** `signIn` opens that tool's sign-in, e.g. from a failed chat reply; a bad value is dropped instead of throwing. */
const AiToolsSearch = z.object({ signIn: z.string().max(64).optional().catch(undefined) });

export const Route = createFileRoute('/settings_/ai-tools')({
    beforeLoad: requireFeature('ai-tools'),
    validateSearch: AiToolsSearch,
    loader: ({ context }) => {
        context.queryClient.query(aiToolsQueryOptions(context.engineApi)).catch(() => undefined);
    },
    component: AiToolsPage,
});
