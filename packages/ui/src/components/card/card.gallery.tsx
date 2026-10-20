import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { Card } from './card';

export const cardGallery: GalleryEntry = {
    id: 'card',
    title: 'Card',
    render: () => (
        <div className="grid gap-4 md:grid-cols-2">
            <Card title="Titled card" actions={<Button size="sm">{'Action'}</Button>}>
                <p className="text-sm text-text-muted">{'Cards group related content on a raised surface.'}</p>
            </Card>
            <Card as="div">
                <p className="text-sm">{'A card without a title.'}</p>
            </Card>
        </div>
    ),
};
