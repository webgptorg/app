import type { ApiFailure } from '../../app/api-errors';
import { m } from '../../paraglide/messages';

/**
 * Everything that can stop a recording, a transcription or a reading, in the browser or on the engine. A closed list,
 * so every one has its own plain sentence; a problem's `detail` from the engine is never shown.
 */
export type VoiceProblem =
    | 'microphone-denied'
    | 'microphone-missing'
    | 'microphone-busy'
    | 'recording-failed'
    | 'clip-too-large'
    | 'clip-too-long'
    | 'clip-format-refused'
    | 'nothing-heard'
    | 'transcription-failed'
    | 'speech-too-long'
    | 'message-not-speakable'
    | 'speech-format-refused'
    | 'speech-failed'
    | 'playback-failed'
    | 'voice-unavailable'
    | 'voice-not-allowed'
    | 'rate-limited'
    | 'connection'
    | 'unexpected';

export type VoiceAction = 'transcribe' | 'speak';

/** What a failed voice call means to the member; `aborted` never reaches here, the caller cancelled it. */
export function voiceProblemFromFailure(failure: Exclude<ApiFailure, { kind: 'aborted' }>, action: VoiceAction) {
    switch (failure.kind) {
        case 'network':
        case 'timeout':
            return 'connection';
        case 'contract':
        case 'unexpected':
            return 'unexpected';
        case 'problem':
            return voiceProblemFromCode(failure.problem.code, action);
    }
}

function voiceProblemFromCode(code: string, action: VoiceAction): VoiceProblem {
    switch (code) {
        case 'payload-too-large':
            return 'clip-too-large';
        case 'voice-clip-too-long':
            return 'clip-too-long';
        case 'unsupported-media-type':
            return action === 'transcribe' ? 'clip-format-refused' : 'speech-format-refused';
        case 'transcription-failed':
        case 'speech-too-long':
        case 'message-not-speakable':
        case 'speech-failed':
        case 'voice-unavailable':
        case 'rate-limited':
            return code;
        case 'forbidden':
        case 'not-found':
        case 'capability-not-supported':
            return 'voice-not-allowed';
        default:
            return 'unexpected';
    }
}

/** Why `getUserMedia` refused, by the `DOMException` name browsers use. */
export function microphoneProblem(error: unknown): VoiceProblem {
    const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : null;
    switch (name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'microphone-denied';
        case 'NotFoundError':
        case 'OverconstrainedError':
            return 'microphone-missing';
        case 'NotReadableError':
            return 'microphone-busy';
        default:
            return 'recording-failed';
    }
}

export function voiceProblemMessage(problem: VoiceProblem): string {
    switch (problem) {
        case 'microphone-denied':
            return m.voice_error_microphone_denied();
        case 'microphone-missing':
            return m.voice_error_microphone_missing();
        case 'microphone-busy':
            return m.voice_error_microphone_busy();
        case 'recording-failed':
            return m.voice_error_recording_failed();
        case 'clip-too-large':
            return m.voice_error_clip_too_large();
        case 'clip-too-long':
            return m.voice_error_clip_too_long();
        case 'clip-format-refused':
            return m.voice_error_clip_format_refused();
        case 'nothing-heard':
            return m.voice_error_nothing_heard();
        case 'transcription-failed':
            return m.voice_error_transcription_failed();
        case 'speech-too-long':
            return m.voice_error_speech_too_long();
        case 'message-not-speakable':
            return m.voice_error_message_not_speakable();
        case 'speech-format-refused':
            return m.voice_error_speech_format_refused();
        case 'speech-failed':
            return m.voice_error_speech_failed();
        case 'playback-failed':
            return m.voice_error_playback_failed();
        case 'voice-unavailable':
            return m.voice_error_unavailable();
        case 'voice-not-allowed':
            return m.voice_error_not_allowed();
        case 'rate-limited':
            return m.voice_error_rate_limited();
        case 'connection':
            return m.voice_error_connection();
        case 'unexpected':
            return m.voice_error_unexpected();
    }
}
