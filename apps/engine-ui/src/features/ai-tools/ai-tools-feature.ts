import { useQueryClient } from '@tanstack/react-query';

import { useEngineEvents } from '../../app/engine-events-context';
import { defineFeature } from '../../app/registry/feature';
import type { Attention } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { AI_TOOLS_READ, aiToolKeys, needsSignIn, useAiTools } from './ai-tools-queries';

/** A tool that needs signing in stops agents, so Home asks for it; a failed check is visible on the page itself. */
function useAiToolsAttention(): Attention {
    const tools = useAiTools().data;
    return { count: tools?.filter(needsSignIn).length ?? 0, to: '/settings/ai-tools', pending: tools === undefined };
}

/** `ai-tool.changed` carries only the tool's ID; the list is short, so it is read again whole. */
function useAiToolsEventSync(): void {
    const queryClient = useQueryClient();
    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: aiToolKeys.list() });
    };
    useEngineEvents({
        onEvent: (event) => {
            if (event.type === 'ai-tool.changed') refresh();
        },
        onReconnect: refresh,
    });
}

/**
 * The project's AI tools (`ai-tools@1`): their status, Check now, and signing one in again or with an API key, so a
 * project on a server never needs its terminal for that. A page under Settings, with no entry of its own in the
 * navigation; Home and a failed chat reply link to it when a tool needs signing in.
 */
export const aiToolsFeature = defineFeature({
    id: 'ai-tools',
    requires: AI_TOOLS_READ,
    commands: [
        {
            id: 'ai-tools.open',
            label: m.ai_tools_title,
            keywords: () => [m.nav_settings(), m.ai_tools_keywords()],
            to: '/settings/ai-tools',
        },
    ],
    attention: {
        id: 'ai-tools.attention',
        useAttention: useAiToolsAttention,
        label: (count) => m.ai_tools_attention({ count }),
        tone: 'danger',
    },
    eventSync: { useEventSync: useAiToolsEventSync },
});
