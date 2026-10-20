import { Check } from 'lucide-react';

import type { GalleryEntry } from '../../gallery-entry';
import { Badge } from './badge';
import type { BadgeTone } from './badge';

const TONES: readonly BadgeTone[] = ['neutral', 'accent', 'success', 'warning', 'danger', 'info'];

export const badgeGallery: GalleryEntry = {
    id: 'badge',
    title: 'Badge',
    render: () => (
        <div className="flex flex-wrap gap-2">
            {TONES.map((tone) => (
                <Badge key={tone} tone={tone}>
                    {tone}
                </Badge>
            ))}
            <Badge tone="success" icon={<Check />}>
                {'with icon'}
            </Badge>
        </div>
    ),
};
