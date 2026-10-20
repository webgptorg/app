import type { GalleryEntry } from '../../gallery-entry';
import { Skeleton } from './skeleton';

export const skeletonGallery: GalleryEntry = {
    id: 'skeleton',
    title: 'Skeleton',
    render: () => (
        <div aria-busy="true" className="flex max-w-md flex-col gap-3">
            <div className="flex items-center gap-3">
                <Skeleton shape="circle" />
                <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton />
            <Skeleton shape="block" />
        </div>
    ),
};
