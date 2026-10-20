import type { ReactNode } from 'react';

/** One component module's section in the gallery: every state it can be in. */
export interface GalleryEntry {
    readonly id: string;
    /** The component's name; the gallery is a developer tool, so names are not translated. */
    readonly title: string;
    readonly render: () => ReactNode;
}
