import { MAX_VOICE_CLIP_BYTES, MAX_VOICE_CLIP_MS } from '@ptbk/engine-api';
import type { TranscriptDraft, VoiceClipFormat } from '@ptbk/engine-api';

import type { VoiceResult } from './voice-api';
import type { VoiceMedia, VoiceMicrophone, VoiceRecorder, VoiceStream } from './voice-media';
import { microphoneProblem } from './voice-problems';
import type { VoiceProblem } from './voice-problems';

/**
 * The recorder stops itself this much before the contract's limit: it starts a moment after `start()`, and the engine
 * measures the decoded clip, so a recording cut at exactly 60 s could come out a few milliseconds over.
 */
export const RECORDING_LIMIT_MS = MAX_VOICE_CLIP_MS - 500;
/** Chunks arrive this often, so the size cap holds while recording, not only at the end. */
const CHUNK_MS = 1_000;

export type PushToTalkState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'starting' }
    | { readonly kind: 'recording'; readonly startedAt: number }
    | { readonly kind: 'transcribing' }
    | { readonly kind: 'failed'; readonly problem: VoiceProblem };

/** What one recording needs; given to `start`, so the machine itself holds nothing but the recording in progress. */
export interface RecordingRequest {
    readonly microphone: VoiceMicrophone;
    readonly clock: Pick<VoiceMedia, 'now' | 'after'>;
    readonly format: VoiceClipFormat;
    readonly transcribe: (clip: Blob, signal: AbortSignal) => Promise<VoiceResult<TranscriptDraft>>;
    /** The transcript, for the composer. Called at most once per recording and never with empty text. */
    readonly onDraft: (text: string) => void;
}

export interface PushToTalk {
    readonly subscribe: (listener: () => void) => () => void;
    readonly state: () => PushToTalkState;
    /** Asks for the microphone and records; does nothing while a recording or transcription is under way. */
    readonly start: (request: RecordingRequest) => void;
    /** Ends the recording and transcribes it. Before the microphone opened, it cancels instead. */
    readonly stop: () => void;
    /** Drops the recording or the transcription in progress and releases the microphone. Safe at any time. */
    readonly cancel: () => void;
}

interface Recording {
    readonly request: RecordingRequest;
    readonly abort: AbortController;
    stream: VoiceStream | null;
    recorder: VoiceRecorder | null;
    chunks: Blob[];
    bytes: number;
    cancelLimit: (() => void) | null;
    finishing: boolean;
}

const IDLE: PushToTalkState = { kind: 'idle' };

/**
 * Push-to-talk without React: record from the microphone, keep the clip within `MAX_VOICE_CLIP_MS` and
 * `MAX_VOICE_CLIP_BYTES`, transcribe it, hand the text on. The microphone is released the moment a recording stops,
 * fails or is cancelled. The audio lives only in this recording's chunks and the clip sent from them; neither is
 * logged, kept after the call or put into a state.
 */
export function createPushToTalk(): PushToTalk {
    const listeners = new Set<() => void>();
    let state: PushToTalkState = IDLE;
    let current: Recording | null = null;

    const set = (next: PushToTalkState) => {
        state = next;
        for (const listener of [...listeners]) listener();
    };

    const release = (recording: Recording) => {
        recording.cancelLimit?.();
        recording.cancelLimit = null;
        for (const track of recording.stream?.getTracks() ?? []) track.stop();
        recording.stream = null;
    };

    const end = (recording: Recording, next: PushToTalkState) => {
        if (current !== recording) return;
        current = null;
        recording.abort.abort();
        recording.recorder?.stop();
        release(recording);
        recording.chunks = [];
        set(next);
    };

    const transcribe = async (recording: Recording) => {
        const { format, transcribe: send, onDraft } = recording.request;
        const clip = new Blob(recording.chunks, { type: format });
        recording.chunks = [];
        if (clip.size === 0) {
            end(recording, { kind: 'failed', problem: 'nothing-heard' });
            return;
        }
        const result = await send(clip, recording.abort.signal);
        if (current !== recording) return;
        switch (result.kind) {
            case 'ok': {
                const text = result.value.text.trim();
                end(recording, text === '' ? { kind: 'failed', problem: 'nothing-heard' } : IDLE);
                if (text !== '') onDraft(text);
                return;
            }
            case 'failed':
                end(recording, { kind: 'failed', problem: result.problem });
                return;
            case 'aborted':
                end(recording, IDLE);
                return;
        }
    };

    const finish = (recording: Recording) => {
        if (recording.finishing) return;
        recording.finishing = true;
        recording.recorder?.stop();
        // The recorder already holds what it heard; releasing now turns the browser's microphone indicator off at once.
        release(recording);
        set({ kind: 'transcribing' });
    };

    const begin = (recording: Recording, stream: VoiceStream) => {
        const { microphone, format, clock } = recording.request;
        recording.stream = stream;
        try {
            recording.recorder = microphone.record(stream, format, {
                onData: (chunk) => {
                    if (current !== recording) return;
                    recording.chunks.push(chunk);
                    recording.bytes += chunk.size;
                    if (recording.bytes > MAX_VOICE_CLIP_BYTES) {
                        end(recording, { kind: 'failed', problem: 'clip-too-large' });
                    }
                },
                onStop: () => {
                    if (current === recording && recording.finishing) void transcribe(recording);
                },
                onError: () => {
                    end(recording, { kind: 'failed', problem: 'recording-failed' });
                },
            });
            recording.recorder.start(CHUNK_MS);
        } catch {
            end(recording, { kind: 'failed', problem: 'recording-failed' });
            return;
        }
        recording.cancelLimit = clock.after(RECORDING_LIMIT_MS, () => {
            finish(recording);
        });
        set({ kind: 'recording', startedAt: clock.now() });
    };

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        state: () => state,
        start(request) {
            if (current !== null) return;
            const recording: Recording = {
                request,
                abort: new AbortController(),
                stream: null,
                recorder: null,
                chunks: [],
                bytes: 0,
                cancelLimit: null,
                finishing: false,
            };
            current = recording;
            set({ kind: 'starting' });
            request.microphone.open().then(
                (stream) => {
                    if (current === recording) begin(recording, stream);
                    else for (const track of stream.getTracks()) track.stop();
                },
                (error: unknown) => {
                    end(recording, { kind: 'failed', problem: microphoneProblem(error) });
                },
            );
        },
        stop() {
            if (current === null) return;
            if (state.kind === 'recording') finish(current);
            else if (state.kind === 'starting') end(current, IDLE);
        },
        cancel() {
            if (current !== null) end(current, IDLE);
            else if (state.kind === 'failed') set(IDLE);
        },
    };
}
