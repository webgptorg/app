import type { GalleryEntry } from '../../gallery-entry';
import { VisuallyHidden } from './visually-hidden';

export const visuallyHiddenGallery: GalleryEntry = {
    id: 'visually-hidden',
    title: 'VisuallyHidden',
    render: () => (
        <p>
            {'Visible text.'}
            <VisuallyHidden>{'Only screen readers hear this.'}</VisuallyHidden>
        </p>
    ),
};
