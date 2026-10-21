import { MAX_MESSAGE_LENGTH } from '@ptbk/engine-api';
import { Button, Field, Textarea } from '@ptbk/ui';
import { SendHorizontal, Square } from 'lucide-react';
import { useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';

import { m } from '../../paraglide/messages';

export interface ComposerProps {
    readonly label: string;
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
export function Composer({ label, placeholder, busy, stop, onSend, onStop, textareaRef }: ComposerProps) {
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
            <Field label={label} hint={m.chat_composer_hint()}>
                {(control) => (
                    <Textarea
                        {...control}
                        {...(textareaRef === undefined ? {} : { ref: textareaRef })}
                        rows={3}
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
            <div className="flex justify-end">
                {stop !== undefined && onStop !== undefined ? (
                    <Button type="button" loading={stop === 'stopping'} onClick={onStop}>
                        <Square aria-hidden className="size-4" />
                        {m.chat_stop()}
                    </Button>
                ) : (
                    <Button type="submit" variant="primary" disabled={!canSend} loading={sending}>
                        <SendHorizontal aria-hidden className="size-4" />
                        {m.chat_send()}
                    </Button>
                )}
            </div>
        </form>
    );
}
