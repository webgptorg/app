import type { GalleryEntry } from '../../gallery-entry';
import { StatusDot, StatusPill } from './status';
import type { StatusTone } from './status';

const STATES: readonly (readonly [StatusTone, string])[] = [
    ['live', 'Running'],
    ['waiting', 'Queued'],
    ['warning', 'Needs you'],
    ['danger', 'Failed'],
    ['success', 'Done'],
    ['info', 'Scheduled'],
    ['neutral', 'Stopped'],
];

export const statusGallery: GalleryEntry = {
    id: 'status',
    title: 'StatusPill and StatusDot',
    render: () => (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
                {STATES.map(([tone, label]) => (
                    <StatusPill key={tone} tone={tone}>
                        {label}
                    </StatusPill>
                ))}
            </div>
            <div className="flex flex-wrap gap-4">
                {STATES.map(([tone, label]) => (
                    <StatusPill key={tone} tone={tone} variant="quiet">
                        {label}
                    </StatusPill>
                ))}
            </div>
            <div className="flex items-center gap-3">
                {STATES.map(([tone, label]) => (
                    <StatusDot key={tone} tone={tone} label={label} />
                ))}
            </div>
        </div>
    ),
};
