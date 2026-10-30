import { MAX_MESSAGE_LENGTH } from '@ptbk/engine-api';
import { Field, IconButton } from '@ptbk/ui';
import { ArrowUp, Square } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';

export interface ComposerProps {
    readonly label: string;
    /** In a conversation the box explains itself; the label stays for assistive technology. */
    readonly labelHidden?: boolean;
    readonly placeholder: string;
    /** A reply is under way: the text cannot change or be sent. */
    readonly busy: boolean;
    /** Whether Stop replaces Send: a reply is streaming (`ready`) or its cancel is on the way (`stopping`). */
    readonly stop?: 'ready' | 'stopping';
    /** Resolves `false` when the message did not go out; the text then comes back into the box. */
    readonly onSend: (content: string) => Promise<boolean>;
    readonly onStop?: () => void;
    readonly textareaRef?: Ref<HTMLTextAreaElement>;
    readonly className?: string;
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null): void {
    if (typeof ref === 'function') ref(value);
    else if (ref !== undefined && ref !== null) ref.current = value;
}

/**
 * One rounded box that grows with its text, with Send (or Stop) inside it. Enter sends, Shift+Enter adds a line, Esc
 * stops a reply. While a reply streams the box is read-only rather than disabled, so focus stays in it and Esc still
 * reaches the panel.
 */
export function Composer({
    label,
    labelHidden = false,
    placeholder,
    busy,
    stop,
    onSend,
    onStop,
    textareaRef,
    className,
}: ComposerProps) {
    const hintId = useId();
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const box = useRef<HTMLTextAreaElement | null>(null);
    const locked = busy || sending;
    const canSend = !locked && text.trim() !== '';

    // `field-sizing: content` would do this in CSS, but not in every browser the engine supports. The height goes
    // through the CSSOM, which the engine's CSP allows; `max-h-*` caps it and the box scrolls from there.
    useLayoutEffect(() => {
        const element = box.current;
        if (element === null) return;
        element.style.height = 'auto';
        // A hidden box (the book's test chat behind the Book view on a phone) measures 0: keep its natural one row.
        element.style.height = element.scrollHeight === 0 ? '' : `${String(element.scrollHeight)}px`;
    }, [text]);

    const submit = async () => {
        if (!canSend) return;
        const content = text;
        setSending(true);
        setText('');
        const sent = await onSend(content);
        setSending(false);
        if (!sent) setText((current) => (current === '' ? content : current));
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        void submit();
    };

    return (
        <form
            className={className}
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <Field label={label} labelHidden={labelHidden}>
                {(control) => (
                    // The box, not the bare textarea, takes the focus ring, so it reads as one control with its button.
                    <div className="flex items-end gap-2 rounded-[1.5rem] border border-border bg-raised p-1.5 ps-4 shadow-subtle focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-focus">
                        <textarea
                            {...control}
                            aria-describedby={hintId}
                            ref={(element) => {
                                box.current = element;
                                setRef(textareaRef, element);
                            }}
                            rows={1}
                            value={text}
                            placeholder={placeholder}
                            maxLength={MAX_MESSAGE_LENGTH}
                            readOnly={locked}
                            aria-disabled={locked || undefined}
                            className={cx(
                                'max-h-[40dvh] min-w-0 flex-1 resize-none self-center overflow-y-auto bg-transparent py-2 text-base text-text outline-none placeholder:text-text-muted',
                                locked && 'text-text-muted',
                            )}
                            onChange={(event) => {
                                setText(event.target.value);
                            }}
                            onKeyDown={onKeyDown}
                        />
                        {stop !== undefined && onStop !== undefined ? (
                            <IconButton
                                label={m.chat_stop()}
                                icon={<Square className="size-3.5 fill-current" />}
                                variant="secondary"
                                loading={stop === 'stopping'}
                                onClick={onStop}
                                className="rounded-full!"
                            />
                        ) : (
                            <IconButton
                                type="submit"
                                label={m.chat_send()}
                                icon={<ArrowUp className="size-4" strokeWidth={2.5} />}
                                variant="primary"
                                disabled={!canSend}
                                loading={sending}
                                className="rounded-full!"
                            />
                        )}
                    </div>
                )}
            </Field>
            <p id={hintId} className="sr-only">
                {m.chat_composer_hint()}
            </p>
        </form>
    );
}
