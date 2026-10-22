import { z } from 'zod';

import type { FeatureDefinition } from '../../../app/registry/feature';

/** The areas the feed can be filtered by, in the order the chips show them. */
export const ACTIVITY_AREAS = ['run', 'file', 'trigger', 'integration', 'member', 'engine'] as const;
export type ActivityArea = (typeof ACTIVITY_AREAS)[number];

/** `?activity=run` on the home route; anything else reads as "all". */
export const HomeSearch = z.object({
    activity: z.enum(ACTIVITY_AREAS).optional().catch(undefined),
});
export type HomeSearch = z.output<typeof HomeSearch>;

/** The area of a kind, `run` for `run.failed`; a kind without a dot has none. */
export function areaOf(kind: string): string | null {
    const dot = kind.indexOf('.');
    return dot <= 0 ? null : kind.slice(0, dot);
}

/**
 * The areas whose cards some visible feature renders, so a chip appears only where the member can see that area at
 * all: no `run.` chip without the runs feature (and so without `runs.read`).
 */
export function visibleAreas(features: readonly FeatureDefinition[]): ActivityArea[] {
    const rendered = new Set(
        features.flatMap((feature) => (feature.activityRenderers ?? []).map((entry) => areaOf(entry.kind))),
    );
    return ACTIVITY_AREAS.filter((area) => rendered.has(area));
}
