import type { GalleryEntry } from '../../gallery-entry';
import { ExternalLink } from './external-link';

export const externalLinkGallery: GalleryEntry = {
    id: 'external-link',
    title: 'ExternalLink',
    render: () => (
        <div className="flex flex-col gap-2">
            <ExternalLink href="https://example.test/docs">{'Documentation'}</ExternalLink>
            <ExternalLink href="https://example.test/docs" showHost={false}>
                {'Without host'}
            </ExternalLink>
            <ExternalLink href="javascript:void(0)">{'Unsafe href renders as text'}</ExternalLink>
        </div>
    ),
};
