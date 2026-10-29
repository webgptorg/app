import type { GalleryEntry } from '../../gallery-entry';
import { CopyButton } from './copy-button';

const reject = () => Promise.reject(new Error('gallery'));

export const copyButtonGallery: GalleryEntry = {
    id: 'copy-button',
    title: 'CopyButton',
    render: () => (
        <div className="flex items-center gap-3">
            <CopyButton value="engine-7f3a" />
            <CopyButton value="engine-7f3a" label="Copy engine ID" variant="secondary" size="md" />
            <CopyButton value="docker run ptbk" label="Copy command" variant="secondary" showLabel />
            <CopyButton value="x" label="Copy (always fails)" copy={reject} />
        </div>
    ),
};
