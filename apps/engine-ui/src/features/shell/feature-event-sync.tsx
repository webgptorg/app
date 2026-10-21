import type { FeatureDefinition } from '../../app/registry/feature';
import { useVisibleFeatures } from '../../app/registry/use-visible-features';

type EventSync = NonNullable<FeatureDefinition['eventSync']>;

/** One component per feature keeps the rules of hooks while features come and go with capabilities. */
function SyncProbe({ sync }: { readonly sync: EventSync }) {
    sync.useEventSync();
    return null;
}

/** Mounts each visible feature's event sync once, for as long as the shell is on screen. */
export function FeatureEventSync() {
    return useVisibleFeatures().map((feature) =>
        feature.eventSync === undefined ? null : <SyncProbe key={feature.id} sync={feature.eventSync} />,
    );
}
