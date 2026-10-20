import type { GalleryEntry } from '../../gallery-entry';
import { Textarea } from './textarea';

export const textareaGallery: GalleryEntry = {
    id: 'textarea',
    title: 'Textarea',
    render: () => (
        <div className="grid max-w-md gap-3">
            <Textarea aria-label="Empty textarea" placeholder="Describe the job in plain words" />
            <Textarea aria-label="Invalid textarea" defaultValue="Too short" invalid />
            <Textarea aria-label="Disabled textarea" defaultValue="Read only" disabled />
        </div>
    ),
};
