import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { Drawer } from './drawer';
import type { DrawerSide } from './drawer';

function DrawerDemo({ side }: { side: DrawerSide }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                onClick={() => {
                    setOpen(true);
                }}
            >{`Open ${side} drawer`}</Button>
            <Drawer
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                side={side}
                title="Navigation"
                footer={
                    <Button
                        onClick={() => {
                            setOpen(false);
                        }}
                    >
                        Done
                    </Button>
                }
            >
                <p className="text-sm">Drawer content scrolls when it is taller than the screen.</p>
            </Drawer>
        </>
    );
}

export const drawerGallery: GalleryEntry = {
    id: 'drawer',
    title: 'Drawer',
    render: () => (
        <div className="flex flex-wrap gap-3">
            <DrawerDemo side="start" />
            <DrawerDemo side="end" />
        </div>
    ),
};
