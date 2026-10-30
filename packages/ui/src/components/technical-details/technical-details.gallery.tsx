import type { GalleryEntry } from '../../gallery-entry';
import { TechnicalDetails } from './technical-details';

export const technicalDetailsGallery: GalleryEntry = {
    id: 'technical-details',
    title: 'TechnicalDetails',
    render: () => (
        <TechnicalDetails
            items={[
                { label: 'SHA-256', value: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' },
                { label: 'Commit', value: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3' },
                { label: 'File ID', value: 'file-weekly-report' },
            ]}
        />
    ),
};
