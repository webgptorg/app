import { X } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode, RefObject } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { useModalDialog } from '../../internal/use-modal-dialog';
import { IconButton } from '../icon-button/icon-button';

export type DialogSize = 'sm' | 'md' | 'lg';

export interface DialogProps {
    readonly open: boolean;
    /** Called for Esc, the close button and a backdrop click; the owner sets `open` to false. */
    readonly onClose: () => void;
    readonly title: string;
    readonly description?: string;
    readonly children?: ReactNode;
    /** Actions, end-aligned under the content. */
    readonly footer?: ReactNode;
    readonly size?: DialogSize;
    /** Where focus goes on open; defaults to the first focusable element. */
    readonly initialFocusRef?: RefObject<HTMLElement | null>;
}

const SIZE_CLASSES: Readonly<Record<DialogSize, string>> = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
};

/**
 * A modal on the native `<dialog>`: the browser puts it in the top layer and makes the page behind it inert. Content
 * renders only while open, so every opening starts fresh.
 */
export function Dialog({
    open,
    onClose,
    title,
    description,
    children,
    footer,
    size = 'md',
    initialFocusRef,
}: DialogProps) {
    const messages = useUiMessages();
    const titleId = useId();
    const descriptionId = useId();
    const dialogRef = useModalDialog({ open, onClose, initialFocusRef });
    return (
        <dialog
            ref={dialogRef}
            data-ptbk-modal=""
            aria-labelledby={titleId}
            aria-describedby={description === undefined ? undefined : descriptionId}
            className={cx(
                'm-auto max-h-[calc(100dvh-var(--spacing)*8)] w-[calc(100%-var(--spacing)*8)] overflow-auto p-0',
                'rounded-(--dialog-radius) border border-(--dialog-border) bg-(--dialog-bg) text-(--dialog-text) shadow-(--dialog-shadow)',
                'motion-safe:animate-[ptbk-dialog-enter_var(--motion-enter)_var(--ease-enter)]',
                SIZE_CLASSES[size],
            )}
        >
            {open ? (
                <div className="flex flex-col gap-4 p-6">
                    <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 flex-col gap-1">
                            <h2 id={titleId} className="text-base font-semibold">
                                {title}
                            </h2>
                            {description === undefined ? null : (
                                <p id={descriptionId} className="text-sm text-(--dialog-muted)">
                                    {description}
                                </p>
                            )}
                        </div>
                        <IconButton
                            label={messages.close()}
                            icon={<X aria-hidden="true" className="size-4" />}
                            size="sm"
                            className="-me-2 -mt-1"
                            onClick={onClose}
                        />
                    </div>
                    {children}
                    {footer === undefined ? null : (
                        <div className="flex flex-wrap items-center justify-end gap-2">{footer}</div>
                    )}
                </div>
            ) : null}
        </dialog>
    );
}
