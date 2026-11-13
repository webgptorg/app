import type { GalleryEntry } from './gallery-entry';

const SURFACES = [
    ['surface', 'bg-surface'],
    ['raised', 'bg-raised'],
    ['sunken', 'bg-sunken'],
    ['hover', 'bg-hover'],
    ['selected', 'bg-selected'],
    ['neutral-soft', 'bg-neutral-soft'],
    ['primary', 'bg-primary'],
] as const;

const STATUS = [
    ['success', 'bg-success', 'bg-success-soft text-success'],
    ['warning', 'bg-warning', 'bg-warning-soft text-warning'],
    ['danger', 'bg-danger', 'bg-danger-soft text-danger'],
    ['info', 'bg-info', 'bg-info-soft text-info'],
    ['live', 'bg-live', 'text-text'],
] as const;

/** The identity's foundations at a glance: type scale, graphite surfaces, status hues, agent colours, teal's three jobs. */
export const identityGallery: GalleryEntry = {
    id: 'identity',
    title: 'Visual identity',
    render: () => (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
                <p className="text-3xl font-semibold tracking-display">{'Calm precision'}</p>
                <p className="text-xl font-semibold tracking-heading">{'Headings are Inter, heavier and tighter'}</p>
                <p className="text-sm">{'Body text is 14px Inter for technical and non-technical people alike.'}</p>
                <p className="meta">{'Meta is 13px with tabular figures: 4:12 · 3 runs · 1.2 MB · 08:00'}</p>
                <p className="font-mono text-xs text-text-muted">{'Mono only for IDs, commits and paths: a1b2c3d'}</p>
            </div>
            <div className="flex flex-wrap gap-3">
                {SURFACES.map(([name, className]) => (
                    <span key={name} className="flex flex-col items-start gap-1 text-xs text-text-muted">
                        <span className={`block h-10 w-20 rounded-control border border-hairline ${className}`} />
                        {name}
                    </span>
                ))}
            </div>
            <div className="flex flex-wrap gap-3">
                {STATUS.map(([name, dot, soft]) => (
                    <span
                        key={name}
                        className={`inline-flex items-center gap-2 rounded-control px-2.5 py-1 text-xs font-medium ${soft}`}
                    >
                        <span aria-hidden="true" className={`size-2 rounded-pill ${dot}`} />
                        {name}
                    </span>
                ))}
            </div>
            <div className="flex flex-wrap gap-2">
                {[1, 2, 3, 4, 5, 6, 7, 8].map((index) => (
                    <span
                        key={index}
                        className={`soft-surface px-2.5 py-1 text-xs font-medium text-tint [--tint:var(--color-agent-${String(index)})]`}
                    >
                        {`agent-${String(index)}`}
                    </span>
                ))}
            </div>
            <p className="max-w-prose text-sm">
                {'Teal has three jobs: the focus ring, '}
                <a href="#identity-link" className="text-link underline underline-offset-2 hover:text-link-hover">
                    {'links in prose'}
                </a>
                {' and the text selection.'}
            </p>
        </div>
    ),
};
