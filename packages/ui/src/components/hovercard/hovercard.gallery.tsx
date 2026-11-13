import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { Hovercard } from './hovercard';

export const hovercardGallery: GalleryEntry = {
    id: 'hovercard',
    title: 'Hovercard',
    render: () => (
        <p>
            {'Ask '}
            <Hovercard
                label="Copywriter"
                content={
                    <span className="flex flex-col gap-2">
                        <span className="font-medium">{'Copywriter'}</span>
                        <span className="text-text-muted">{'Writes and edits marketing copy.'}</span>
                        <span className="flex gap-2">
                            <Button size="sm">{'Open agent'}</Button>
                            <Button size="sm" variant="ghost">
                                {'Mention'}
                            </Button>
                        </span>
                    </span>
                }
            >
                {(props) => (
                    <button type="button" {...props} className="font-medium underline">
                        {'@Copywriter'}
                    </button>
                )}
            </Hovercard>
            {' to rewrite the headline.'}
        </p>
    ),
};
