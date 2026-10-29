import { useState } from 'react';

import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { Dialog } from '../dialog/dialog';
import { useToast } from './toast-store';
import type { ToastTone } from './toast-store';

const TONES: readonly ToastTone[] = ['info', 'success', 'warning', 'danger'];

function ToasterDemo() {
    const toast = useToast();
    const [dialogOpen, setDialogOpen] = useState(false);
    return (
        <div className="flex flex-wrap gap-3">
            {TONES.map((tone) => (
                <Button
                    key={tone}
                    onClick={() => toast.show({ tone, title: `A ${tone} toast`, description: 'With a description.' })}
                >
                    {`Show ${tone}`}
                </Button>
            ))}
            <Button
                onClick={() => {
                    void toast
                        .promise(
                            new Promise((resolve) => {
                                setTimeout(resolve, 1500);
                            }),
                            { loading: 'Saving the agent', success: 'Agent saved', error: 'Could not save' },
                        )
                        .catch(() => undefined);
                }}
            >
                Show promise
            </Button>
            <Button
                onClick={() => {
                    setDialogOpen(true);
                }}
            >
                Open a dialog
            </Button>
            <Dialog
                open={dialogOpen}
                onClose={() => {
                    setDialogOpen(false);
                }}
                title="Revoke this passkey?"
            >
                <Button
                    variant="danger"
                    onClick={() =>
                        toast.show({
                            tone: 'danger',
                            title: 'This device is the last passkey, so it cannot be revoked.',
                            description: 'SLACK_WEBHOOK_URL_FOR_THE_SUPPORT_TEAM_CHANNEL_WITH_A_VERY_LONG_NAME',
                        })
                    }
                >
                    Fail inside the dialog
                </Button>
            </Dialog>
        </div>
    );
}

/** Shows toasts in the app's own `<Toaster />`; a second live region on the page would announce twice. */
export const toasterGallery: GalleryEntry = { id: 'toaster', title: 'Toaster', render: () => <ToasterDemo /> };
