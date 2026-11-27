import type { ComponentType } from 'react';

import { m } from '../../../paraglide/messages';
import { BrowserArt, DashboardArt, EngineArt, RelayArt, SealedPath } from './trust-art';

type Side = 'yours' | 'ours';

interface Stop {
    readonly id: string;
    readonly side: Side;
    readonly place: () => string;
    readonly title: () => string;
    readonly body: () => string;
    readonly Art: ComponentType<{ readonly className?: string }>;
}

const BROWSER: Stop = {
    id: 'browser',
    side: 'yours',
    place: () => m.trust_path_your_device(),
    title: () => m.trust_path_browser_title(),
    body: () => m.trust_path_browser_body(),
    Art: BrowserArt,
};

const RELAY: Stop = {
    id: 'relay',
    side: 'ours',
    place: () => m.trust_path_promptbook(),
    title: () => m.trust_path_relay_title(),
    body: () => m.trust_path_relay_body(),
    Art: RelayArt,
};

const ENGINE: Stop = {
    id: 'engine',
    side: 'yours',
    place: () => m.trust_path_your_server(),
    title: () => m.trust_path_engine_title(),
    body: () => m.trust_path_engine_body(),
    Art: EngineArt,
};

/** Who owns a stop is the point of the diagram: yours are filled, ours are only outlined. */
const SIDE_CLASSES: Readonly<Record<Side, { readonly frame: string; readonly place: string }>> = {
    yours: { frame: 'bg-accent-soft', place: 'text-accent-text' },
    ours: { frame: 'border border-dashed border-border', place: 'text-text-muted' },
};

function StopCard(props: { readonly stop: Stop; readonly layout: 'column' | 'row' }) {
    const { stop } = props;
    const side = SIDE_CLASSES[stop.side];
    return (
        <div
            data-trust-stop={stop.id}
            className={`flex gap-3 rounded-surface p-4 ${side.frame} ${props.layout === 'row' ? 'flex-col sm:flex-row sm:items-center sm:gap-5' : 'flex-col'}`}
        >
            <stop.Art className="h-14 w-18 shrink-0 text-text" />
            <div className="flex flex-col gap-1">
                <p className={`font-mono text-xs tracking-wide uppercase ${side.place}`}>{stop.place()}</p>
                <h3 className="text-lg font-semibold">{stop.title()}</h3>
                <p className="text-sm text-text-muted">{stop.body()}</p>
            </div>
        </div>
    );
}

function Connection() {
    return (
        <div aria-hidden="true" className="flex items-center justify-center py-1 md:px-1 md:py-0">
            <SealedPath direction="down" className="h-12 w-5 md:hidden" />
            <SealedPath direction="across" className="hidden h-6 w-16 md:block" />
        </div>
    );
}

const DASHBOARD: Stop = {
    id: 'dashboard',
    side: 'ours',
    place: () => m.trust_path_promptbook(),
    title: () => m.trust_path_dashboard_title(),
    body: () => m.trust_path_dashboard_body(),
    Art: DashboardArt,
};

/**
 * Browser, relay, engine, and the dashboard beside that path (spec, Architecture). Built from HTML around small
 * drawings rather than one large SVG, so the labels wrap in either language and turn from a row into a column on a
 * phone.
 */
export function TrustPath() {
    return (
        <section aria-labelledby="trust-path-title" className="flex flex-col gap-4">
            <h2 id="trust-path-title" className="text-xl font-semibold">
                {m.trust_path_title()}
            </h2>
            <div className="flex flex-col gap-3 rounded-surface border border-divider bg-raised p-3 shadow-subtle sm:p-5">
                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
                    <StopCard stop={BROWSER} layout="column" />
                    <Connection />
                    <StopCard stop={RELAY} layout="column" />
                    <Connection />
                    <StopCard stop={ENGINE} layout="column" />
                </div>
                <StopCard stop={DASHBOARD} layout="row" />
            </div>
        </section>
    );
}
