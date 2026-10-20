import type { GalleryEntry } from '../../gallery-entry';
import { Anchor } from './anchor';

export const anchorGallery: GalleryEntry = {
    id: 'anchor',
    title: 'Anchor',
    render: () => (
        <div className="flex flex-col gap-2">
            <p>
                {'Running text with an '}
                <Anchor href="#gallery-anchor">{'inline link'}</Anchor>
                {' in it.'}
            </p>
            <Anchor href="#gallery-anchor" variant="standalone">
                {'Standalone link'}
            </Anchor>
        </div>
    ),
};
