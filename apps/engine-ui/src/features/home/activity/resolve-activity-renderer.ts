import type { Activity, ActivityItem } from '@ptbk/engine-api';

import { findActivityRenderer } from '../../../app/registry/activity-renderers';
import type { ActivityRendererEntry, FeatureDefinition } from '../../../app/registry/feature';

export type ResolvedRenderer =
    | { readonly kind: 'renderer'; readonly entry: ActivityRendererEntry; readonly activity: Activity }
    | { readonly kind: 'fallback' };

const FALLBACK: ResolvedRenderer = { kind: 'fallback' };

/**
 * The renderer for one feed item, by the registry's lookup (an exact kind claiming its `v`, then the `area.*` entry
 * claiming it), or the generic card. Items the client could not read (`unknown`, `invalid`) always get the generic
 * card, so no renderer ever sees a payload that did not pass its schema.
 */
export function resolveActivityRenderer(item: ActivityItem, features: readonly FeatureDefinition[]): ResolvedRenderer {
    if (item.kind !== 'known') return FALLBACK;
    const entry = findActivityRenderer(features, item.activity.kind, item.activity.v);
    return entry === undefined ? FALLBACK : { kind: 'renderer', entry, activity: item.activity };
}
