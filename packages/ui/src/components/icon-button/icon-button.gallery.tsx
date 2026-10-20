import { Plus, Trash2, X } from 'lucide-react';

import type { GalleryEntry } from '../../gallery-entry';
import { IconButton } from './icon-button';

export const iconButtonGallery: GalleryEntry = {
    id: 'icon-button',
    title: 'IconButton',
    render: () => (
        <div className="flex flex-wrap items-center gap-3">
            <IconButton label="Close" icon={<X />} />
            <IconButton label="Add" icon={<Plus />} variant="primary" />
            <IconButton label="Add small" icon={<Plus />} variant="secondary" size="sm" />
            <IconButton label="Delete" icon={<Trash2 />} variant="danger" />
            <IconButton label="Saving" icon={<Plus />} variant="primary" loading />
            <IconButton label="Disabled" icon={<Plus />} disabled />
            <IconButton label="Delete agent" icon={<Trash2 />} disabled disabledReason="Not allowed for your role" />
        </div>
    ),
};
