import { MAX_SPEECH_TEXT_LENGTH } from '@ptbk/engine-api';
import type { ChatId, MessageId } from '@ptbk/engine-api';
import type { ButtonSize } from '@ptbk/ui';

import { m } from '../../paraglide/messages';
import { ReadAloudButton } from './read-aloud-button';
import { useReadAloud } from './use-voice';
import type { UseReadAloudOptions } from './use-voice';
import { useVoiceOutputSupport } from './voice-support';

export interface MessageReadAloudProps {
    readonly chatId: ChatId;
    readonly messageId: MessageId;
    /** The message's `content` as the API sent it: the engine counts its length the same way. */
    readonly content: string;
    /** The engine speaks only a completed message; anything else would be 409 `message-not-speakable`. */
    readonly completed: boolean;
    readonly size?: ButtonSize;
    readonly className?: string;
}

function AvailableReadAloud({
    support,
    chatId,
    messageId,
    content,
    size,
    className,
}: MessageReadAloudProps & Pick<UseReadAloudOptions, 'support'>) {
    const { state, toggle } = useReadAloud({ chatId, messageId, support });
    return (
        <ReadAloudButton
            state={state}
            onToggle={toggle}
            disabledReason={content.length > MAX_SPEECH_TEXT_LENGTH ? m.voice_error_speech_too_long() : undefined}
            {...(size === undefined ? {} : { size })}
            {...(className === undefined ? {} : { className })}
        />
    );
}

/**
 * Read aloud for one message, wired to the engine. Renders nothing unless the engine advertises `voice-output@1`, the
 * member may read chats, the browser plays a format the contract offers, and the message is complete and has text.
 */
export function MessageReadAloud(props: MessageReadAloudProps) {
    const support = useVoiceOutputSupport();
    if (support.kind === 'unavailable' || !props.completed || props.content.trim() === '') return null;
    return <AvailableReadAloud {...props} support={support} />;
}
