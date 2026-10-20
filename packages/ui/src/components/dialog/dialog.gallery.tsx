import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { Dialog } from './dialog';
import type { DialogSize } from './dialog';

function DialogDemo({ size }: { size: DialogSize }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                onClick={() => {
                    setOpen(true);
                }}
            >{`Open ${size} dialog`}</Button>
            <Dialog
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                size={size}
                title="Rename agent"
                description="Members see the new name at once."
                footer={
                    <>
                        <Button
                            variant="ghost"
                            onClick={() => {
                                setOpen(false);
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={() => {
                                setOpen(false);
                            }}
                        >
                            Save
                        </Button>
                    </>
                }
            >
                <p className="text-sm">The agent keeps its history, triggers and integrations.</p>
            </Dialog>
        </>
    );
}

export const dialogGallery: GalleryEntry = {
    id: 'dialog',
    title: 'Dialog',
    render: () => (
        <div className="flex flex-wrap gap-3">
            <DialogDemo size="sm" />
            <DialogDemo size="md" />
            <DialogDemo size="lg" />
        </div>
    ),
};
