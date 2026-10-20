import type { GalleryEntry } from '../../gallery-entry';
import { Input } from '../input/input';
import { Field } from './field';

export const fieldGallery: GalleryEntry = {
    id: 'field',
    title: 'Field',
    render: () => (
        <div className="grid max-w-md gap-4">
            <Field label="Agent name">{(control) => <Input {...control} />}</Field>
            <Field label="Description" hint="Members see this on the agent card.">
                {(control) => <Input {...control} />}
            </Field>
            <Field label="Email" required error="Enter a valid email address.">
                {(control) => <Input {...control} type="email" defaultValue="lead@" />}
            </Field>
        </div>
    ),
};
