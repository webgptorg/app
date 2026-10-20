import type { GalleryEntry } from '../../gallery-entry';
import { CodeText } from './code-text';

export const codeTextGallery: GalleryEntry = {
    id: 'code-text',
    title: 'CodeText',
    render: () => (
        <div className="flex flex-col items-start gap-3">
            <CodeText value="k3x9v2m7q8p4w6t1" />
            <CodeText value="7F3A9C2D1E8B4F6A0C5D" group={4} copyable />
            <CodeText value="sha256:4f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0" copyable />
        </div>
    ),
};
