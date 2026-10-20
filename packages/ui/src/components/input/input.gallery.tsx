import type { GalleryEntry } from '../../gallery-entry';
import { Input } from './input';

export const inputGallery: GalleryEntry = {
    id: 'input',
    title: 'Input',
    render: () => (
        <div className="grid max-w-md gap-3">
            <Input aria-label="Empty" placeholder="Placeholder" />
            <Input aria-label="Filled" defaultValue="Lead bot" />
            <Input aria-label="Invalid" defaultValue="not-an-email" invalid />
            <Input aria-label="Disabled" defaultValue="Read only" disabled />
        </div>
    ),
};
