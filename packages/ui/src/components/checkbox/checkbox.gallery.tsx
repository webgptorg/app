import type { GalleryEntry } from '../../gallery-entry';
import { Checkbox } from './checkbox';

export const checkboxGallery: GalleryEntry = {
    id: 'checkbox',
    title: 'Checkbox',
    render: () => (
        <div className="flex flex-col gap-3">
            <Checkbox label="Unchecked" />
            <Checkbox label="Checked" defaultChecked />
            <Checkbox label="With description" description="A short explanation under the label." />
            <Checkbox label="Mixed" indeterminate />
            <Checkbox label="Disabled" disabled />
            <Checkbox aria-label="Without visible label" />
        </div>
    ),
};
