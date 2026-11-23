import type { SpeechFormat } from '@ptbk/engine-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeVoiceMedia } from '../../testing/fake-voice-media';
import { createSpeechPlayer } from './speech-player';
import type { ReadingRequest } from './speech-player';
import type { VoiceResult } from './voice-api';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const FORMATS: readonly SpeechFormat[] = ['audio/mpeg', 'audio/wav'];
const AUDIO = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });

function setup(
    answer: (formats: readonly SpeechFormat[], signal: AbortSignal) => Promise<VoiceResult<Blob>> = () =>
        Promise.resolve({ kind: 'ok', value: AUDIO }),
) {
    const media = createFakeVoiceMedia();
    const speaker = media.speaker;
    if (speaker === null) throw new Error('the fake has a speaker');
    const speak = vi.fn(answer);
    const request: ReadingRequest = { speaker, formats: FORMATS, speak };
    return { media, player: createSpeechPlayer(), speak, request };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('speech player', () => {
    it('opens the output at once, asks for the formats, plays the audio and frees the output at the end', async () => {
        const createObjectURL = vi.spyOn(URL, 'createObjectURL');
        const { media, player, speak, request } = setup();
        const listener = vi.fn();
        const unsubscribe = player.subscribe(listener);
        player.play(request);
        expect(media.outputs).toHaveLength(1);
        expect(player.state()).toEqual({ kind: 'loading' });
        await flush();
        expect(speak).toHaveBeenCalledWith(FORMATS, expect.any(AbortSignal));
        expect(player.state()).toEqual({ kind: 'playing' });
        const output = media.outputs[0];
        expect(output?.played.map((audio) => [...new Uint8Array(audio)])).toEqual([[1, 2, 3]]);

        output?.end();
        expect(player.state()).toEqual({ kind: 'idle' });
        expect(output?.closed).toBe(true);
        expect(listener).toHaveBeenCalled();
        // The engine's CSP has no media-src: playback never goes through a blob: URL.
        expect(createObjectURL).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('stops while loading: the call is aborted, the output closed and a late answer ignored', async () => {
        let answer: (result: VoiceResult<Blob>) => void = () => undefined;
        const { media, player, speak, request } = setup(
            () =>
                new Promise((resolve) => {
                    answer = resolve;
                }),
        );
        player.play(request);
        player.play(request);
        expect(media.outputs).toHaveLength(1);
        player.stop();
        expect(speak.mock.calls[0]?.[1].aborted).toBe(true);
        expect(media.outputs[0]?.closed).toBe(true);
        answer({ kind: 'ok', value: AUDIO });
        await flush();
        expect(media.outputs[0]?.played).toHaveLength(0);
        expect(player.state()).toEqual({ kind: 'idle' });
    });

    it('stops while playing and frees the output', async () => {
        const { media, player, request } = setup();
        player.play(request);
        await flush();
        player.stop();
        expect(player.state()).toEqual({ kind: 'idle' });
        expect(media.outputs[0]?.closed).toBe(true);
    });

    it('shows the engine refusing and clears the failure on stop', async () => {
        const { media, player, request } = setup(() => Promise.resolve({ kind: 'failed', problem: 'speech-too-long' }));
        player.play(request);
        await flush();
        expect(player.state()).toEqual({ kind: 'failed', problem: 'speech-too-long' });
        expect(media.outputs[0]?.closed).toBe(true);
        player.stop();
        expect(player.state()).toEqual({ kind: 'idle' });
    });

    it('treats an aborted call as stopped', async () => {
        const { player, request } = setup(() => Promise.resolve({ kind: 'aborted' }));
        player.play(request);
        await flush();
        expect(player.state()).toEqual({ kind: 'idle' });
    });

    it('fails to play audio the browser cannot decode, or without an audio output', async () => {
        const { media, player, request } = setup();
        media.refuseDecode();
        player.play(request);
        await flush();
        expect(player.state()).toEqual({ kind: 'failed', problem: 'playback-failed' });
        expect(media.outputs[0]?.closed).toBe(true);

        media.refuseOutput();
        player.play(request);
        expect(player.state()).toEqual({ kind: 'failed', problem: 'playback-failed' });
        expect(media.outputs).toHaveLength(1);
    });
});
