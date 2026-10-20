import type { GalleryEntry } from '../../gallery-entry';
import { RelativeTime } from './relative-time';

const NOW = new Date('2026-10-20T12:00:00.000Z');

export const relativeTimeGallery: GalleryEntry = {
    id: 'relative-time',
    title: 'RelativeTime',
    render: () => (
        <ul className="flex flex-col gap-1 text-sm">
            <li>
                <RelativeTime value={new Date('2026-10-20T11:59:30.000Z')} now={NOW} />
            </li>
            <li>
                <RelativeTime value={new Date('2026-10-20T09:00:00.000Z')} now={NOW} />
            </li>
            <li>
                <RelativeTime value={new Date('2026-10-23T12:00:00.000Z')} now={NOW} />
            </li>
        </ul>
    ),
};
