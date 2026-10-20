import { useEffect, useState } from 'react';

import { useVisibleFeatures } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';

interface CountSource {
    readonly id: string;
    readonly useActiveCount: () => number;
}

/** Calls one feature's counting hook; one component per source keeps the rules of hooks with any number of them. */
function CountProbe({
    source,
    onCount,
}: {
    readonly source: CountSource;
    readonly onCount: (id: string, count: number) => void;
}) {
    const count = source.useActiveCount();
    useEffect(() => {
        onCount(source.id, count);
    }, [source.id, count, onCount]);
    return null;
}

/**
 * A quiet, breathing dot with a text label while any registered feature reports active work (runs, U-09); nothing at
 * zero. The status region stays mounted so screen readers hear it appear.
 */
export function LiveIndicator({ compact = false }: { readonly compact?: boolean }) {
    const sources = useVisibleFeatures().flatMap((feature) =>
        feature.liveIndicator === undefined
            ? []
            : [{ id: feature.id, useActiveCount: feature.liveIndicator.useActiveCount }],
    );
    const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
    const [onCount] = useState(() => (id: string, count: number) => {
        setCounts((previous) => (previous.get(id) === count ? previous : new Map(previous).set(id, count)));
    });
    const total = sources.reduce((sum, source) => sum + (counts.get(source.id) ?? 0), 0);
    const label = m.live_active({ count: total });
    return (
        <div role="status" className="min-h-6">
            {sources.map((source) => (
                <CountProbe key={source.id} source={source} onCount={onCount} />
            ))}
            {total > 0 ? (
                <span
                    className="inline-flex items-center gap-2 text-sm text-text-muted"
                    title={compact ? label : undefined}
                >
                    <span
                        aria-hidden="true"
                        className="size-2.5 rounded-pill bg-live motion-safe:animate-[ptbk-breathe_var(--motion-live)_var(--ease-standard)_infinite]"
                    />
                    <span className={compact ? 'sr-only' : undefined}>{label}</span>
                </span>
            ) : null}
        </div>
    );
}
