import type { GalleryEntry } from '../../gallery-entry';
import { ErrorState } from './error-state';

export const errorStateGallery: GalleryEntry = {
    id: 'error-state',
    title: 'ErrorState',
    render: () => (
        <div className="grid gap-4 md:grid-cols-2">
            <ErrorState
                message="The engine did not answer in time."
                onRetry={() => undefined}
                details="problem: timeout, correlation 7f3a"
            />
            <ErrorState title="Retrying" message="Trying again." onRetry={() => undefined} retrying />
        </div>
    ),
};
