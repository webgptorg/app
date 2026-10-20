import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { ConfirmDialog } from './confirm-dialog';

function ConfirmDemo({ phrase }: { phrase?: string }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                variant="danger"
                onClick={() => {
                    setOpen(true);
                }}
            >
                {phrase === undefined ? 'Stop run' : 'Delete agent'}
            </Button>
            <ConfirmDialog
                open={open}
                onClose={() => {
                    setOpen(false);
                }}
                onConfirm={() => {
                    setOpen(false);
                }}
                title={phrase === undefined ? 'Stop this run?' : 'Delete Lead bot?'}
                description="This cannot be undone."
                confirmLabel={phrase === undefined ? 'Stop' : 'Delete'}
                tone="danger"
                {...(phrase === undefined ? {} : { confirmPhrase: phrase })}
            />
        </>
    );
}

export const confirmDialogGallery: GalleryEntry = {
    id: 'confirm-dialog',
    title: 'ConfirmDialog',
    render: () => (
        <div className="flex flex-wrap gap-3">
            <ConfirmDemo />
            <ConfirmDemo phrase="Lead bot" />
        </div>
    ),
};
