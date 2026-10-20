import { useRouteContext } from '@tanstack/react-router';
import { useMemo } from 'react';

import { usePermissions } from '../../features/session/use-permissions';
import type { FeatureDefinition } from './feature';
import { visibleFeatures } from './visibility';

/** The registered features, from the router context (tests swap in their own list). */
export function useFeatures(): readonly FeatureDefinition[] {
    return useRouteContext({ from: '__root__', select: (context) => context.features });
}

/** The features, and their nested entries, the engine and the member's permissions allow. */
export function useVisibleFeatures(): readonly FeatureDefinition[] {
    const features = useFeatures();
    const { can } = usePermissions();
    return useMemo(() => visibleFeatures(features, { can }), [features, can]);
}
