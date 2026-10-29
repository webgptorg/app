import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useUiMessages } from '../../i18n/ui-provider';
import { Button } from '../button/button';
import type { ButtonSize, ButtonVariant } from '../button/button';
import { IconButton } from '../icon-button/icon-button';

export interface CopyButtonProps {
    readonly value: string;
    /** The button's accessible name; defaults to "Copy". */
    readonly label?: string;
    /** Defaults to the async Clipboard API; injectable for tests and for environments without it. */
    readonly copy?: (text: string) => Promise<void>;
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
    readonly className?: string;
    /**
     * Shows the label next to the icon, and "Copied" in its place for a moment, for the one copy a screen exists for
     * (an install command) rather than one copy icon among many.
     */
    readonly showLabel?: boolean;
}

type CopyState = 'idle' | 'copied' | 'failed';

/** How long the check mark and the announcement stay before the button resets. */
export const COPY_FEEDBACK_MS = 2000;

async function writeToClipboard(text: string): Promise<void> {
    if (typeof navigator === 'undefined' || typeof navigator.clipboard === 'undefined') {
        throw new Error('Clipboard API unavailable');
    }
    await navigator.clipboard.writeText(text);
}

/** Copies `value` and says so through a polite live region, since the icon change alone is visual only. */
export function CopyButton({
    value,
    label,
    copy = writeToClipboard,
    variant = 'ghost',
    size = 'sm',
    className,
    showLabel = false,
}: CopyButtonProps) {
    const messages = useUiMessages();
    const [state, setState] = useState<CopyState>('idle');
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(
        () => () => {
            clearTimeout(timer.current);
        },
        [],
    );

    const settle = (next: CopyState) => {
        setState(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            setState('idle');
        }, COPY_FEEDBACK_MS);
    };
    const handleClick = () => {
        copy(value).then(
            () => {
                settle('copied');
            },
            () => {
                settle('failed');
            },
        );
    };

    return (
        <>
            {showLabel ? (
                <Button
                    variant={variant}
                    size={size}
                    onClick={handleClick}
                    {...(className === undefined ? {} : { className })}
                >
                    {state === 'copied' ? (
                        <Check aria-hidden="true" className="size-4" />
                    ) : (
                        <Copy aria-hidden="true" className="size-4" />
                    )}
                    {state === 'copied' ? messages.copied() : (label ?? messages.copy())}
                </Button>
            ) : (
                <IconButton
                    label={label ?? messages.copy()}
                    icon={state === 'copied' ? <Check /> : <Copy />}
                    variant={variant}
                    size={size}
                    onClick={handleClick}
                    {...(className === undefined ? {} : { className })}
                />
            )}
            <span role="status" className="sr-only">
                {state === 'copied' ? messages.copied() : state === 'failed' ? messages.copyFailed() : ''}
            </span>
        </>
    );
}
