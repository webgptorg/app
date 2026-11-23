import type { ChatId } from '@ptbk/engine-api';
import type { ButtonSize } from '@ptbk/ui';

import { useNow } from '../../app/ticker';
import { PushToTalkButton } from './push-to-talk-button';
import type { PushToTalkButtonProps } from './push-to-talk-button';
import { usePushToTalk } from './use-voice';
import type { UsePushToTalkOptions } from './use-voice';
import { useVoiceInputSupport } from './voice-support';

export interface ComposerVoiceInputProps {
    readonly chatId: ChatId;
    /** Puts the transcript into the composer for the member to edit; it is never sent from here. */
    readonly onDraft: (text: string) => void;
    readonly disabled?: boolean;
    readonly language?: string;
    readonly size?: ButtonSize;
    readonly className?: string;
}

/** Ticks only while recording, so an idle composer keeps the app's shared clock stopped. */
function RecordingButton(props: Omit<PushToTalkButtonProps, 'elapsedMs'> & { readonly startedAt: number }) {
    const now = useNow();
    return <PushToTalkButton {...props} elapsedMs={now - props.startedAt} />;
}

function AvailableVoiceInput({
    support,
    chatId,
    onDraft,
    language,
    disabled,
    size,
    className,
}: ComposerVoiceInputProps & Pick<UsePushToTalkOptions, 'support'>) {
    const { state, start, stop, cancel } = usePushToTalk({ chatId, support, onDraft, language });
    const props = {
        state,
        onStart: start,
        onStop: stop,
        onCancel: cancel,
        ...(disabled === undefined ? {} : { disabled }),
        ...(size === undefined ? {} : { size }),
        ...(className === undefined ? {} : { className }),
    };
    return state.kind === 'recording' ? (
        <RecordingButton {...props} startedAt={state.startedAt} />
    ) : (
        <PushToTalkButton {...props} elapsedMs={0} />
    );
}

/**
 * Push-to-talk for the composer, wired to the engine. Renders nothing unless the engine advertises `voice-input@1`, the
 * member may write in chats and the browser can record a format the contract takes.
 */
export function ComposerVoiceInput(props: ComposerVoiceInputProps) {
    const support = useVoiceInputSupport();
    return support.kind === 'available' ? <AvailableVoiceInput {...props} support={support} /> : null;
}
