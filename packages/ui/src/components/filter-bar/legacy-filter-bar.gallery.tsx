import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { LegacyFilterBar } from './legacy-filter-bar';

const STATUSES = [
    { value: 'working', label: 'Working' },
    { value: 'idle', label: 'Idle' },
    { value: 'failed', label: 'Failed' },
] as const;
const AGENTS = [
    { value: 'ada', label: 'Ada' },
    { value: 'grace', label: 'Grace' },
] as const;

function LegacyFilterBarDemo({ empty = false }: { readonly empty?: boolean }) {
    const [q, setQ] = useState('');
    const [status, setStatus] = useState<readonly string[]>(empty ? [] : ['working']);
    const [agent, setAgent] = useState<string | undefined>(undefined);
    const [from, setFrom] = useState<string | undefined>(undefined);
    return (
        <LegacyFilterBar
            empty={empty}
            search={{ label: 'Search runs', value: q, onChange: setQ }}
            filters={[
                { kind: 'multi', id: 'status', label: 'Status', options: STATUSES, value: status, onChange: setStatus },
                {
                    kind: 'select',
                    id: 'agent',
                    label: 'Agent',
                    allLabel: 'All agents',
                    options: AGENTS,
                    value: agent,
                    onChange: setAgent,
                },
                { kind: 'date', id: 'from', label: 'From', value: from, onChange: setFrom },
            ]}
            onClear={() => {
                setQ('');
                setStatus([]);
                setAgent(undefined);
                setFrom(undefined);
            }}
        />
    );
}

/** Narrow viewports (the CSP suite's 360 px pass) show the collapsed "Filters" button and chips instead. */
export const legacyFilterBarGallery: GalleryEntry = {
    id: 'legacy-filter-bar',
    title: 'LegacyFilterBar',
    render: () => (
        <div className="flex flex-col gap-6">
            <LegacyFilterBarDemo />
            <p className="text-sm text-text-muted">{'An empty, unfiltered list renders no bar:'}</p>
            <LegacyFilterBarDemo empty />
        </div>
    ),
};
