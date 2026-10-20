import type { GalleryEntry } from '../../gallery-entry';
import { Switch } from './switch';

export const switchGallery: GalleryEntry = {
    id: 'switch',
    title: 'Switch',
    render: () => (
        <div className="flex max-w-md flex-col gap-3">
            <Switch label="Off" />
            <Switch label="On" defaultChecked />
            <Switch label="With description" description="Applies immediately." />
            <Switch label="Disabled" disabled />
        </div>
    ),
};
