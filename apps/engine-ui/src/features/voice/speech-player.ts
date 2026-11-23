import type { SpeechFormat } from '@ptbk/engine-api';

import type { VoiceResult } from './voice-api';
import type { VoiceAudioOutput, VoiceSpeaker } from './voice-media';
import type { VoiceProblem } from './voice-problems';

export type ReadAloudState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'loading' }
    | { readonly kind: 'playing' }
    | { readonly kind: 'failed'; readonly problem: VoiceProblem };

/** What one reading needs; given to `play`, so the player itself holds nothing but the reading in progress. */
export interface ReadingRequest {
    readonly speaker: VoiceSpeaker;
    readonly formats: readonly SpeechFormat[];
    readonly speak: (formats: readonly SpeechFormat[], signal: AbortSignal) => Promise<VoiceResult<Blob>>;
}

export interface SpeechPlayer {
    readonly subscribe: (listener: () => void) => () => void;
    readonly state: () => ReadAloudState;
    /** Opens the audio output at once (call it from the click), then fetches the speech and plays it. */
    readonly play: (request: ReadingRequest) => void;
    /** Stops loading or playing and frees the audio output; clears a failure too. Safe at any time. */
    readonly stop: () => void;
}

interface Reading {
    readonly abort: AbortController;
    readonly output: VoiceAudioOutput;
}

const IDLE: ReadAloudState = { kind: 'idle' };

/** Read aloud without React. The audio is decoded and played through Web Audio and dropped when it ends or stops. */
export function createSpeechPlayer(): SpeechPlayer {
    const listeners = new Set<() => void>();
    let state: ReadAloudState = IDLE;
    let current: Reading | null = null;

    const set = (next: ReadAloudState) => {
        state = next;
        for (const listener of [...listeners]) listener();
    };

    const end = (reading: Reading, next: ReadAloudState) => {
        if (current !== reading) return;
        current = null;
        reading.abort.abort();
        reading.output.close();
        set(next);
    };

    const run = async (reading: Reading, request: ReadingRequest) => {
        const result = await request.speak(request.formats, reading.abort.signal);
        if (current !== reading) return;
        switch (result.kind) {
            case 'failed':
                end(reading, { kind: 'failed', problem: result.problem });
                return;
            case 'aborted':
                end(reading, IDLE);
                return;
            case 'ok':
                break;
        }
        try {
            const audio = await result.value.arrayBuffer();
            await reading.output.play(audio, () => {
                end(reading, IDLE);
            });
        } catch {
            end(reading, { kind: 'failed', problem: 'playback-failed' });
            return;
        }
        if (current === reading) set({ kind: 'playing' });
    };

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        state: () => state,
        play(request) {
            if (current !== null) return;
            let output: VoiceAudioOutput;
            try {
                output = request.speaker.open();
            } catch {
                set({ kind: 'failed', problem: 'playback-failed' });
                return;
            }
            const reading: Reading = { abort: new AbortController(), output };
            current = reading;
            set({ kind: 'loading' });
            void run(reading, request);
        },
        stop() {
            if (current !== null) end(current, IDLE);
            else if (state.kind === 'failed') set(IDLE);
        },
    };
}
