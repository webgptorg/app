import { X } from 'lucide-react';
import { useId } from 'react';
import type { ReactNode, RefObject } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { cx } from '../../internal/cx';
import { useModalDialog } from '../../internal/use-modal-dialog';
import { IconButton } from '../icon-button/icon-button';

export type DrawerSide = 'start' | 'end';

export interface DrawerProps {
    readonly open: boolean;
    readonly onClose: () => void;
    readonly title: string;
    readonly side?: DrawerSide;
    readonly children?: ReactNode;
    readonly footer?: ReactNode;
    readonly initialFocusRef?: RefObject<HTMLElement | null>;
}

const SIDE_CLASSES: Readonly<Record<DrawerSide, string>> = {
    start: 'me-auto ms-0 border-e motion-safe:animate-[ptbk-drawer-enter-start_var(--motion-enter)_var(--ease-enter)]',
    end: 'ms-auto me-0 border-s motion-safe:animate-[ptbk-drawer-enter-end_var(--motion-enter)_var(--ease-enter)]',
};

/** A side sheet on the native `<dialog>`, with the same focus rules as `Dialog`; the shell's mobile navigation. */
export function Drawer({ open, onClose, title, side = 'end', children, footer, initialFocusRef }: DrawerProps) {
    const messages = useUiMessages();
    const titleId = useId();
    const dialogRef = useModalDialog({ open, onClose, initialFocusRef });
    return (
        <dialog
            ref={dialogRef}
            data-ptbk-modal=""
            data-side={side}
            aria-labelledby={titleId}
            className={cx(
                'my-0 h-dvh max-h-dvh w-[calc(100%-var(--spacing)*12)] max-w-sm overflow-auto p-0',
                'border-(--drawer-border) bg-(--drawer-bg) text-(--drawer-text) shadow-(--drawer-shadow)',
                SIDE_CLASSES[side],
            )}
        >
            {open ? (
                <div className="flex min-h-full flex-col">
                    <div className="flex items-center justify-between gap-4 border-b border-(--drawer-border) px-4 py-3">
                        <h2 id={titleId} className="text-base font-semibold">
                            {title}
                        </h2>
                        <IconButton
                            label={messages.close()}
                            icon={<X aria-hidden="true" className="size-4" />}
                            size="sm"
                            onClick={onClose}
                        />
                    </div>
                    <div className="flex-1 p-4">{children}</div>
                    {footer === undefined ? null : (
                        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-(--drawer-border) p-4">
                            {footer}
                        </div>
                    )}
                </div>
            ) : null}
        </dialog>
    );
}
