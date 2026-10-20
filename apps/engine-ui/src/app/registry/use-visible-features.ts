import { useSuspenseQuery } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { useMemo } from 'react';

import { engineInfoQueryOptions } from '../../features/engine/engine-queries';
import { meQueryOptions } from '../../features/session/session-queries';
import { useEngineApi } from '../engine-api-context';
import type { FeatureDefinition } from './feature';
import { accessFrom } from './engine-access';
import { visibleFeatures } from './visibility';

/** The registered features, from the router context (tests swap in their own list). */
export function useFeatures(): readonly FeatureDefinition[] {
    return useRouteContext({ from: '__root__', select: (context) => context.features });
}

/** The capabilities `GET /engine` advertises; an engine on API 1.0 advertises none. */
export function useEngineCapabilities() {
    return useSuspenseQuery(engineInfoQueryOptions(useEngineApi())).data.capabilities;
}

/** The features, and their nested entries, the engine's capabilities and the member's permissions allow. */
export function useVisibleFeatures(): readonly FeatureDefinition[] {
    const features = useFeatures();
    const engineApi = useEngineApi();
    const capabilities = useEngineCapabilities();
    const { data: me } = useSuspenseQuery(meQueryOptions(engineApi));
    return useMemo(
        () => visibleFeatures(features, accessFrom({ capabilities }, me.permissions)),
        [features, capabilities, me],
    );
}
