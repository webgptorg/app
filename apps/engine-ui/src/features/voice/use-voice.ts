import type { ChatId, MessageId } from '@ptbk/engine-api';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { createPushToTalk } from './push-to-talk';
import type { PushToTalkState } from './push-to-talk';
import { createSpeechPlayer } from './speech-player';
import type { ReadAloudState } from './speech-player';
import { speakMessage, transcribeClip } from './voice-api';
import type { VoiceInputSupport, VoiceOutputSupport } from './voice-support';

export interface UsePushToTalkOptions {
    readonly chatId: ChatId;
    readonly support: Extract<VoiceInputSupport, { kind: 'available' }>;
    /** Receives the transcript for the composer; the one current when the recording started is called. */
    readonly onDraft: (text: string) => void;
    /** A BCP 47 tag, only when the UI knows what the member speaks; otherwise the engine detects it. */
    readonly language?: string | undefined;
}

export interface PushToTalkControls {
    readonly state: PushToTalkState;
    readonly start: () => void;
    readonly stop: () => void;
    readonly cancel: () => void;
}

/** Push-to-talk for one chat. Unmounting or switching chats cancels it and releases the microphone. */
export function usePushToTalk({ chatId, support, onDraft, language }: UsePushToTalkOptions): PushToTalkControls {
    const engineApi = useEngineApi();
    const [machine] = useState(createPushToTalk);
    const state = useSyncExternalStore(machine.subscribe, machine.state);
    useEffect(
        () => () => {
            machine.cancel();
        },
        [machine, chatId],
    );
    const start = useCallback(() => {
        machine.start({
            microphone: support.microphone,
            clock: support.media,
            format: support.format,
            transcribe: (clip, signal) => transcribeClip(engineApi, { chatId, clip, language }, signal),
            onDraft,
        });
    }, [machine, support, engineApi, chatId, language, onDraft]);
    return { state, start, stop: machine.stop, cancel: machine.cancel };
}

export interface UseReadAloudOptions {
    readonly chatId: ChatId;
    readonly messageId: MessageId;
    readonly support: Extract<VoiceOutputSupport, { kind: 'available' }>;
}

export interface ReadAloudControls {
    readonly state: ReadAloudState;
    /** Starts reading, or stops a reading that is loading or playing. */
    readonly toggle: () => void;
}

/** Read one message aloud. Unmounting or switching messages stops it and frees the audio output. */
export function useReadAloud({ chatId, messageId, support }: UseReadAloudOptions): ReadAloudControls {
    const engineApi = useEngineApi();
    const [player] = useState(createSpeechPlayer);
    const state = useSyncExternalStore(player.subscribe, player.state);
    useEffect(
        () => () => {
            player.stop();
        },
        [player, chatId, messageId],
    );
    const busy = state.kind === 'loading' || state.kind === 'playing';
    const toggle = useCallback(() => {
        if (busy) {
            player.stop();
            return;
        }
        player.stop();
        player.play({
            speaker: support.speaker,
            formats: support.formats,
            speak: (formats, signal) => speakMessage(engineApi, { chatId, messageId, formats }, signal),
        });
    }, [busy, player, support, engineApi, chatId, messageId]);
    return { state, toggle };
}
