import type { GalleryEntry } from '../../gallery-entry';
import { Button } from '../button/button';
import { useToast } from './toast-store';
import type { ToastTone } from './toast-store';

const TONES: readonly ToastTone[] = ['info', 'success', 'warning', 'danger'];

function ToasterDemo() {
    const toast = useToast();
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
        </div>
    );
}

/** Shows toasts in the app's own `<Toaster />`; a second live region on the page would announce twice. */
export const toasterGallery: GalleryEntry = { id: 'toaster', title: 'Toaster', render: () => <ToasterDemo /> };
