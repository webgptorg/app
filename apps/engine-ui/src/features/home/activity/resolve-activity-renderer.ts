import type { ActivityItem } from '@ptbk/engine-api';

import type { ActivityRendererEntry } from '../../../app/registry/feature';
import { areaOf } from './activity-areas';

export type ResolvedRenderer =
    { readonly kind: 'renderer'; readonly entry: ActivityRendererEntry } | { readonly kind: 'fallback' };

const FALLBACK: ResolvedRenderer = { kind: 'fallback' };

/**
 * The renderer for one item: an exact `kind` claiming its `v`, then the `area.*` entry claiming that `v`, then the
 * generic card. Items the client could not read (`unknown`, `invalid`) always get the generic card, so no renderer
 * ever sees a payload that did not pass its schema.
 */
export function resolveActivityRenderer(
    item: ActivityItem,
    renderers: readonly ActivityRendererEntry[],
): ResolvedRenderer {
    if (item.kind !== 'known') return FALLBACK;
    const { kind, v } = item.activity;
    const claims = (entry: ActivityRendererEntry, claimed: string) =>
        entry.kind === claimed && entry.versions.includes(v);
    const exact = renderers.find((entry) => claims(entry, kind));
    if (exact !== undefined) return { kind: 'renderer', entry: exact };
    const area = areaOf(kind);
    const prefix = area === null ? undefined : renderers.find((entry) => claims(entry, `${area}.*`));
    return prefix === undefined ? FALLBACK : { kind: 'renderer', entry: prefix };
}
