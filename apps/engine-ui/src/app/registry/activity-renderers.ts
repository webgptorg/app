import type { ActivityRendererEntry, FeatureDefinition } from './feature';

/** `run.failed` matches the entry `run.failed` and the area entry `run.*`. */
export function activityKindMatches(entryKind: string, kind: string): boolean {
    return entryKind.endsWith('.*') ? kind.startsWith(entryKind.slice(0, -1)) : entryKind === kind;
}

/**
 * The renderer a visible feature registered for this kind and version, an exact kind before an area prefix; `undefined`
 * when none claims it, so the caller shows its generic card.
 */
export function findActivityRenderer(
    features: readonly FeatureDefinition[],
    kind: string,
    version: number,
): ActivityRendererEntry | undefined {
    const entries = features.flatMap((feature) => feature.activityRenderers ?? []);
    const claims = (entry: ActivityRendererEntry) =>
        entry.versions.includes(version) && activityKindMatches(entry.kind, kind);
    return entries.find((entry) => entry.kind === kind && claims(entry)) ?? entries.find(claims);
}
