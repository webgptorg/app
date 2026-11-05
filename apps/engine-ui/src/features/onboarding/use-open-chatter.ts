import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { useEngineApi } from '../../app/engine-api-context';

/**
 * Goes to a chat with Chatter, the engine's spokesperson, which sets the engine up through conversation when the
 * member skips the form. Without one (an engine that has no Chatter), home is the next best place.
 */
export function useOpenChatter(): () => Promise<void> {
    const engineApi = useEngineApi();
    const navigate = useNavigate();
    return useCallback(async () => {
        const found = await engineApi.agents.list(
            { origin: 'core', q: 'Chatter', limit: 10 },
            AbortSignal.timeout(10_000),
        );
        const chatter = found.kind === 'ok' ? found.data.items.find(({ name }) => name === 'Chatter') : undefined;
        if (chatter === undefined) {
            await navigate({ to: '/' });
            return;
        }
        await navigate({ to: '/agents/$agentId/chat', params: { agentId: chatter.id } });
    }, [engineApi, navigate]);
}
