import type {
    ChatId,
    EngineApiClient,
    EngineApiResponse,
    MessageId,
    SpeechFormat,
    TranscriptDraft,
} from '@ptbk/engine-api';

import { classifyApiError } from '../../app/api-errors';
import type { ApiFailure } from '../../app/api-errors';
import { voiceProblemFromFailure } from './voice-problems';
import type { VoiceAction, VoiceProblem } from './voice-problems';

/** A voice call's outcome as a value; `aborted` means the member (or an unmount) cancelled it, so nothing is shown. */
export type VoiceResult<Value> =
    | { readonly kind: 'ok'; readonly value: Value }
    | { readonly kind: 'failed'; readonly problem: VoiceProblem }
    | { readonly kind: 'aborted' };

/** Speech-to-text and text-to-speech are provider calls that can take a while, but not forever. */
const VOICE_TIMEOUT_MS = 60_000;

async function settle<Value>(
    action: VoiceAction,
    signal: AbortSignal,
    call: (signal: AbortSignal) => Promise<EngineApiResponse<Value>>,
): Promise<VoiceResult<Value>> {
    let failure: ApiFailure;
    try {
        const response = await call(AbortSignal.any([signal, AbortSignal.timeout(VOICE_TIMEOUT_MS)]));
        if (response.kind === 'ok') return { kind: 'ok', value: response.data };
        failure = { kind: 'problem', problem: response.problem };
    } catch (error) {
        failure = classifyApiError(error);
    }
    if (signal.aborted || failure.kind === 'aborted') return { kind: 'aborted' };
    return { kind: 'failed', problem: voiceProblemFromFailure(failure, action) };
}

/** `voice-input@1`: the clip's `type` is its `Content-Type`. The draft is for the composer and is never sent from here. */
export function transcribeClip(
    engineApi: EngineApiClient,
    request: { readonly chatId: ChatId; readonly clip: Blob; readonly language?: string | undefined },
    signal: AbortSignal,
): Promise<VoiceResult<TranscriptDraft>> {
    const query = request.language === undefined ? {} : { language: request.language };
    return settle('transcribe', signal, (combined) =>
        engineApi.voice.transcribe(request.chatId, request.clip, query, combined),
    );
}

/** `voice-output@1`: the audio in the first of `formats` the engine can make. */
export function speakMessage(
    engineApi: EngineApiClient,
    request: { readonly chatId: ChatId; readonly messageId: MessageId; readonly formats: readonly SpeechFormat[] },
    signal: AbortSignal,
): Promise<VoiceResult<Blob>> {
    return settle('speak', signal, (combined) =>
        engineApi.voice.speak(request.chatId, request.messageId, { formats: [...request.formats] }, combined),
    );
}
