import { KNOWN_CAPABILITIES, SPEECH_FORMATS, VOICE_CLIP_FORMATS } from '@ptbk/engine-api';
import type { SpeechFormat, VoiceClipFormat } from '@ptbk/engine-api';
import { useMemo } from 'react';

import { useBrowser } from '../../app/browser-context';
import { useAllows } from '../../app/registry/use-visible-features';
import { createWindowVoiceMedia } from './voice-media';
import type { VoiceMedia, VoiceMicrophone, VoiceSpeaker } from './voice-media';

/** Whoever may write in a chat may speak into it; whoever may read a message may hear it. */
export const VOICE_INPUT_REQUIREMENT = {
    capability: KNOWN_CAPABILITIES.voiceInput,
    permission: 'chats.write',
} as const;
export const VOICE_OUTPUT_REQUIREMENT = {
    capability: KNOWN_CAPABILITIES.voiceOutput,
    permission: 'chats.read',
} as const;

/** The first clip format the contract allows that this browser's `MediaRecorder` makes, or `null` for none. */
export function pickClipFormat(microphone: VoiceMicrophone): VoiceClipFormat | null {
    return VOICE_CLIP_FORMATS.find((format) => microphone.isTypeSupported(format)) ?? null;
}

/** The speech formats this browser plays, in the contract's order of preference. */
export function pickSpeechFormats(speaker: VoiceSpeaker): readonly SpeechFormat[] {
    return SPEECH_FORMATS.filter((format) => speaker.canPlayType(format));
}

export function useVoiceMedia(): VoiceMedia {
    const injected = useBrowser().voiceMedia;
    return useMemo(() => injected ?? createWindowVoiceMedia(), [injected]);
}

export type VoiceInputSupport =
    | {
          readonly kind: 'available';
          readonly microphone: VoiceMicrophone;
          readonly format: VoiceClipFormat;
          readonly media: VoiceMedia;
      }
    | { readonly kind: 'unavailable' };

export type VoiceOutputSupport =
    | {
          readonly kind: 'available';
          readonly speaker: VoiceSpeaker;
          readonly formats: readonly SpeechFormat[];
      }
    | { readonly kind: 'unavailable' };

/** Push-to-talk only when the engine advertises `voice-input@1`, the member may write and the browser can record. */
export function useVoiceInputSupport(): VoiceInputSupport {
    const allowed = useAllows(VOICE_INPUT_REQUIREMENT);
    const media = useVoiceMedia();
    return useMemo(() => {
        const microphone = media.microphone;
        if (!allowed || microphone === null) return { kind: 'unavailable' };
        const format = pickClipFormat(microphone);
        return format === null ? { kind: 'unavailable' } : { kind: 'available', microphone, format, media };
    }, [allowed, media]);
}

/** Read aloud only when the engine advertises `voice-output@1`, the member may read and the browser plays a format. */
export function useVoiceOutputSupport(): VoiceOutputSupport {
    const allowed = useAllows(VOICE_OUTPUT_REQUIREMENT);
    const media = useVoiceMedia();
    return useMemo(() => {
        const speaker = media.speaker;
        if (!allowed || speaker === null) return { kind: 'unavailable' };
        const formats = pickSpeechFormats(speaker);
        return formats.length === 0 ? { kind: 'unavailable' } : { kind: 'available', speaker, formats };
    }, [allowed, media]);
}
