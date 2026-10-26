import type { GalleryEntry } from '../../gallery-entry';
import { Monogram } from './monogram';

export const monogramGallery: GalleryEntry = {
    id: 'monogram',
    title: 'Monogram',
    render: () => (
        <div className="flex items-center gap-3">
            <Monogram name="Ada Lovelace" />
            <button type="button" className="flex items-center gap-2 rounded-control p-1.5">
                <Monogram name="grace@example.com" />
                <span className="text-sm">grace@example.com</span>
            </button>
        </div>
    ),
};
