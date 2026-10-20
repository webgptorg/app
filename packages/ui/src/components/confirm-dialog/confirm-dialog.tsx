import { useRef, useState } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { Button } from '../button/button';
import { Dialog } from '../dialog/dialog';
import { Field } from '../field/field';
import { Input } from '../input/input';

export interface ConfirmDialogProps {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly onConfirm: () => void | Promise<void>;
    readonly title: string;
    readonly description?: string;
    readonly confirmLabel: string;
    readonly tone?: 'primary' | 'danger';
    /** For irreversible actions: the confirm button stays disabled until this exact text is typed. */
    readonly confirmPhrase?: string;
    /** The confirmed action is running; the owner closes the dialog when it is done. */
    readonly loading?: boolean;
}

/** Asks before an action; focus starts on Cancel (or the phrase field), so Enter never confirms by accident. */
export function ConfirmDialog({
    open,
    onClose,
    onConfirm,
    title,
    description,
    confirmLabel,
    tone = 'primary',
    confirmPhrase,
    loading = false,
}: ConfirmDialogProps) {
    const messages = useUiMessages();
    const cancelRef = useRef<HTMLButtonElement>(null);
    const phraseRef = useRef<HTMLInputElement>(null);
    const [typed, setTyped] = useState('');
    const [wasOpen, setWasOpen] = useState(open);
    // Each opening starts with an empty phrase, however the dialog was closed.
    if (open !== wasOpen) {
        setWasOpen(open);
        if (!open) setTyped('');
    }
    const confirmed = confirmPhrase === undefined || typed === confirmPhrase;
    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={title}
            size="sm"
            initialFocusRef={confirmPhrase === undefined ? cancelRef : phraseRef}
            {...(description === undefined ? {} : { description })}
            footer={
                <>
                    <Button ref={cancelRef} variant="ghost" onClick={onClose}>
                        {messages.cancel()}
                    </Button>
                    <Button
                        variant={tone}
                        loading={loading}
                        disabled={!confirmed}
                        onClick={() => {
                            void onConfirm();
                        }}
                    >
                        {confirmLabel}
                    </Button>
                </>
            }
        >
            {confirmPhrase === undefined ? null : (
                <Field label={messages.typeToConfirm({ phrase: confirmPhrase })}>
                    {(control) => (
                        <Input
                            {...control}
                            ref={phraseRef}
                            value={typed}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) => {
                                setTyped(event.target.value);
                            }}
                        />
                    )}
                </Field>
            )}
        </Dialog>
    );
}
