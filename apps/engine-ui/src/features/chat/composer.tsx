import { MAX_MESSAGE_LENGTH } from '@ptbk/engine-api';
import { Button, Field, Textarea } from '@ptbk/ui';
import { SendHorizontal, Square } from 'lucide-react';
import { useId, useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';

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
}

/**
 * Enter sends, Shift+Enter adds a line, Esc stops a reply. While a reply streams the box is read-only rather than
 * disabled, so focus stays in it and Esc still reaches the panel.
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
}: ComposerProps) {
    const hintId = useId();
    const [text, setText] = useState('');
    const [sending, setSending] = useState(false);
    const locked = busy || sending;
    const canSend = !locked && text.trim() !== '';

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
            className="flex flex-col gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <Field label={label} labelHidden={labelHidden}>
                {(control) => (
                    <Textarea
                        {...control}
                        aria-describedby={hintId}
                        {...(textareaRef === undefined ? {} : { ref: textareaRef })}
                        rows={2}
                        value={text}
                        placeholder={placeholder}
                        maxLength={MAX_MESSAGE_LENGTH}
                        readOnly={locked}
                        aria-disabled={locked || undefined}
                        className="resize-y"
                        onChange={(event) => {
                            setText(event.target.value);
                        }}
                        onKeyDown={onKeyDown}
                    />
                )}
            </Field>
            {/* The hint shares the button's row so the composer stays short enough for a phone's first screen. */}
            <div className="flex items-center justify-between gap-3">
                <p id={hintId} className="sr-only text-xs text-text-muted sm:not-sr-only">
                    {m.chat_composer_hint()}
                </p>
                {stop !== undefined && onStop !== undefined ? (
                    <Button type="button" loading={stop === 'stopping'} onClick={onStop} className="ms-auto">
                        <Square aria-hidden className="size-4" />
                        {m.chat_stop()}
                    </Button>
                ) : (
                    <Button type="submit" variant="primary" disabled={!canSend} loading={sending} className="ms-auto">
                        <SendHorizontal aria-hidden className="size-4" />
                        {m.chat_send()}
                    </Button>
                )}
            </div>
        </form>
    );
}
