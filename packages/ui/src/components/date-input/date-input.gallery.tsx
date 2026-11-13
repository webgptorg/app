import type { GalleryEntry } from '../../gallery-entry';
import { Field } from '../field/field';
import { DateInput } from './date-input';

export const dateInputGallery: GalleryEntry = {
    id: 'date-input',
    title: 'DateInput',
    render: () => (
        <div className="grid max-w-md gap-3">
            <DateInput aria-label="Due date" defaultValue="2026-11-13" />
            <DateInput aria-label="Starts at" withTime defaultValue="2026-11-13T09:30" />
            <DateInput aria-label="Empty date" />
            <DateInput aria-label="Invalid date" invalid defaultValue="2026-02-01" />
            <DateInput aria-label="Disabled date" disabled defaultValue="2026-11-13" />
            <Field label="Run until" hint="Agents stop working on it after this day.">
                {(control) => <DateInput {...control} className="max-w-48" />}
            </Field>
        </div>
    ),
};
