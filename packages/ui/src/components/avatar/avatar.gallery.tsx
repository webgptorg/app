import type { GalleryEntry } from '../../gallery-entry';
import { Avatar } from './avatar';
import type { AvatarSize } from './avatar';

const AGENTS = ['Ada', 'Brief', 'Copywriter', 'Daily', 'Echo', 'Fiona', 'Gatekeeper', 'Iris'];
const SIZES: readonly AvatarSize[] = ['2xs', 'xs', 'sm', 'md', 'lg'];

export const avatarGallery: GalleryEntry = {
    id: 'avatar',
    title: 'Avatar',
    render: () => (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
                {AGENTS.map((name, index) => (
                    <span key={name} className="inline-flex items-center gap-2 text-sm">
                        <Avatar name={name} tint={`var(--color-agent-${String(index + 1)})`} size="md" />
                        {name}
                    </span>
                ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
                {SIZES.map((size) => (
                    <Avatar key={size} name="Šárka" tint="var(--color-agent-6)" size={size} />
                ))}
                <Avatar name="Member" size="md" />
            </div>
        </div>
    ),
};
