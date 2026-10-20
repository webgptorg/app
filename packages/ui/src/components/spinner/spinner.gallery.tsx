import type { GalleryEntry } from '../../gallery-entry';
import { Spinner } from './spinner';

export const spinnerGallery: GalleryEntry = {
    id: 'spinner',
    title: 'Spinner',
    render: () => (
        <div className="flex items-center gap-4">
            <Spinner />
            <Spinner size="sm" />
            <span className="text-danger">
                <Spinner size="sm" tone="current" announce={false} />
            </span>
        </div>
    ),
};
