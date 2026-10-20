import type { GalleryEntry } from '../../gallery-entry';
import { SkipLink } from './skip-link';

export const skipLinkGallery: GalleryEntry = {
    id: 'skip-link',
    title: 'SkipLink',
    render: () => (
        <div className="flex flex-col gap-2 text-sm">
            <p>{'Tab into this section to reveal the skip link.'}</p>
            <SkipLink targetId="gallery-skip-link" />
        </div>
    ),
};
