import type { GalleryEntry } from '../../gallery-entry';
import { EmptyValue } from './empty-value';

export const emptyValueGallery: GalleryEntry = {
    id: 'empty-value',
    title: 'EmptyValue',
    render: () => (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-muted">{'Duration'}</dt>
            <dd>{'3 min 5 s'}</dd>
            <dt className="text-text-muted">{'Cost'}</dt>
            <dd>
                <EmptyValue label="Not reported" />
            </dd>
        </dl>
    ),
};
