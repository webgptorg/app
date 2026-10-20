import { Inbox } from 'lucide-react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { EmptyState } from './empty-state';

export const emptyStateGallery: GalleryEntry = {
    id: 'empty-state',
    title: 'EmptyState',
    render: () => (
        <div className="grid gap-4 md:grid-cols-2">
            <EmptyState
                title="No agents yet"
                description="Agents you create appear here."
                icon={<Inbox className="size-6" />}
                action={<Button variant="primary">{'New agent'}</Button>}
            />
            <EmptyState title="Nothing to show" />
        </div>
    ),
};
