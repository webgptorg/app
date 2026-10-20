import type { GalleryEntry } from '../../gallery-entry';
import { Select } from './select';

export const selectGallery: GalleryEntry = {
    id: 'select',
    title: 'Select',
    render: () => (
        <div className="grid max-w-md gap-3">
            <Select aria-label="Language" defaultValue="en">
                <option value="en">{'English'}</option>
                <option value="cs">{'Čeština'}</option>
            </Select>
            <Select aria-label="Invalid select" invalid defaultValue="">
                <option value="">{'Choose…'}</option>
            </Select>
            <Select aria-label="Disabled select" disabled>
                <option>{'Disabled'}</option>
            </Select>
        </div>
    ),
};
