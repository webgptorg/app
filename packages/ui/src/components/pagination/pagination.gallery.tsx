import type { GalleryEntry } from '../../gallery-entry';
import { Pagination } from './pagination';

const noop = () => undefined;

export const paginationGallery: GalleryEntry = {
    id: 'pagination',
    title: 'Pagination',
    render: () => (
        <div className="flex flex-col gap-4">
            <Pagination hasPrevious={false} hasNext onPrevious={noop} onNext={noop} total={128} />
            <Pagination hasPrevious hasNext onPrevious={noop} onNext={noop} />
            <Pagination hasPrevious hasNext={false} onPrevious={noop} onNext={noop} disabled />
        </div>
    ),
};
