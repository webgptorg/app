import { MAX_VOICE_CLIP_BYTES, MAX_VOICE_CLIP_MS } from '@ptbk/engine-api';
import type { TranscriptDraft } from '@ptbk/engine-api';
import { describe, expect, it, vi } from 'vitest';

import { createFakeVoiceMedia } from '../../testing/fake-voice-media';
import type { FakeVoiceMedia } from '../../testing/fake-voice-media';
import { createPushToTalk, RECORDING_LIMIT_MS } from './push-to-talk';
import type { RecordingRequest } from './push-to-talk';
import type { VoiceResult } from './voice-api';

const FORMAT = 'audio/webm;codecs=opus';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const draft = (text: string): VoiceResult<TranscriptDraft> => ({
    kind: 'ok',
    value: { text, language: 'en', confidence: 0.9, durationMs: 1_000 },
});

function setup(
    answer: (clip: Blob, signal: AbortSignal) => Promise<VoiceResult<TranscriptDraft>> = () =>
        Promise.resolve(draft('Hello, Ada.')),
) {
    const media = createFakeVoiceMedia();
    const machine = createPushToTalk();
    const transcribe = vi.fn(answer);
    const onDraft = vi.fn<(text: string) => void>();
    const microphone = media.microphone;
    if (microphone === null) throw new Error('the fake has a microphone');
    const request: RecordingRequest = { microphone, clock: media, format: FORMAT, transcribe, onDraft };
    return { media, machine, transcribe, onDraft, request };
}

async function recording(
    media: FakeVoiceMedia,
    machine: ReturnType<typeof createPushToTalk>,
    request: RecordingRequest,
) {
    machine.start(request);
    expect(machine.state()).toEqual({ kind: 'starting' });
    await flush();
    expect(machine.state()).toEqual({ kind: 'recording', startedAt: media.now() });
    const recorder = media.recorders.at(-1);
    if (recorder === undefined) throw new Error('no recorder');
    return recorder;
}

describe('push-to-talk', () => {
    it('records in the chosen format, releases the microphone on stop and hands the transcript on', async () => {
        const { media, machine, transcribe, onDraft, request } = setup();
        const listener = vi.fn();
        const unsubscribe = machine.subscribe(listener);
        const recorder = await recording(media, machine, request);
        expect(recorder).toMatchObject({ mediaType: FORMAT, timesliceMs: 1_000, state: 'recording' });
        expect(media.liveTracks()).toBe(1);

        recorder.emit(new Blob(['first']));
        media.lastChunk = new Blob(['last']);
        machine.stop();
        expect(machine.state()).toEqual({ kind: 'transcribing' });
        expect(media.liveTracks()).toBe(0);
        await flush();

        expect(transcribe).toHaveBeenCalledOnce();
        const clip = transcribe.mock.calls[0]?.[0];
        expect(clip?.type).toBe(FORMAT);
        expect(await clip?.text()).toBe('firstlast');
        expect(onDraft).toHaveBeenCalledWith('Hello, Ada.');
        expect(machine.state()).toEqual({ kind: 'idle' });
        expect(listener).toHaveBeenCalled();
        unsubscribe();
    });

    it.each([
        ['NotAllowedError', 'microphone-denied'],
        ['SecurityError', 'microphone-denied'],
        ['NotFoundError', 'microphone-missing'],
        ['OverconstrainedError', 'microphone-missing'],
        ['NotReadableError', 'microphone-busy'],
        ['AbortError', 'recording-failed'],
    ])('says why when the browser refuses the microphone with %s', async (name, problem) => {
        const { media, machine, transcribe, request } = setup();
        media.refuseMicrophone(name);
        machine.start(request);
        await flush();
        expect(machine.state()).toEqual({ kind: 'failed', problem });
        expect(media.recorders).toHaveLength(0);
        expect(transcribe).not.toHaveBeenCalled();
    });

    it('releases a microphone granted after the member cancelled', async () => {
        const { media, machine, request } = setup();
        const grant = media.holdMicrophone();
        machine.start(request);
        machine.stop();
        expect(machine.state()).toEqual({ kind: 'idle' });
        grant();
        await flush();
        expect(media.tracks).toHaveLength(1);
        expect(media.liveTracks()).toBe(0);
        expect(media.recorders).toHaveLength(0);
        expect(machine.state()).toEqual({ kind: 'idle' });
    });

    it('stops by itself before the length cap and transcribes what it has', async () => {
        const { media, machine, transcribe, request } = setup();
        expect(RECORDING_LIMIT_MS).toBeLessThan(MAX_VOICE_CLIP_MS);
        const recorder = await recording(media, machine, request);
        recorder.emit(new Blob(['speech']));
        media.advance(RECORDING_LIMIT_MS - 1);
        expect(recorder.state).toBe('recording');
        media.advance(1);
        expect(recorder.state).toBe('inactive');
        expect(media.liveTracks()).toBe(0);
        await flush();
        expect(transcribe).toHaveBeenCalledOnce();
    });

    it('drops a recording over the byte cap without sending it', async () => {
        const { media, machine, transcribe, request } = setup();
        const recorder = await recording(media, machine, request);
        recorder.emit(new Blob([new Uint8Array(MAX_VOICE_CLIP_BYTES)]));
        expect(machine.state()).toEqual({ kind: 'recording', startedAt: 0 });
        recorder.emit(new Blob([new Uint8Array(1)]));
        expect(machine.state()).toEqual({ kind: 'failed', problem: 'clip-too-large' });
        expect(media.liveTracks()).toBe(0);
        await flush();
        expect(transcribe).not.toHaveBeenCalled();
    });

    it('releases the microphone when the recorder fails or cannot start', async () => {
        const { media, machine, request } = setup();
        const recorder = await recording(media, machine, request);
        recorder.fail();
        expect(machine.state()).toEqual({ kind: 'failed', problem: 'recording-failed' });
        expect(media.liveTracks()).toBe(0);

        media.refuseRecorder();
        machine.start(request);
        await flush();
        expect(machine.state()).toEqual({ kind: 'failed', problem: 'recording-failed' });
        expect(media.tracks).toHaveLength(2);
        expect(media.liveTracks()).toBe(0);
    });

    it('hears nothing in an empty recording or an empty transcript, and sends no draft', async () => {
        const { media, machine, transcribe, onDraft, request } = setup(() => Promise.resolve(draft('   ')));
        await recording(media, machine, request);
        machine.stop();
        await flush();
        expect(transcribe).not.toHaveBeenCalled();
        expect(machine.state()).toEqual({ kind: 'failed', problem: 'nothing-heard' });

        const recorder = await recording(media, machine, request);
        recorder.emit(new Blob(['hum']));
        machine.stop();
        await flush();
        expect(transcribe).toHaveBeenCalledOnce();
        expect(machine.state()).toEqual({ kind: 'failed', problem: 'nothing-heard' });
        expect(onDraft).not.toHaveBeenCalled();
    });

    it('shows the engine refusing the clip and clears the failure on cancel', async () => {
        const { media, machine, onDraft, request } = setup(() =>
            Promise.resolve({ kind: 'failed', problem: 'clip-too-long' }),
        );
        const recorder = await recording(media, machine, request);
        recorder.emit(new Blob(['speech']));
        machine.stop();
        await flush();
        expect(machine.state()).toEqual({ kind: 'failed', problem: 'clip-too-long' });
        expect(onDraft).not.toHaveBeenCalled();
        machine.cancel();
        expect(machine.state()).toEqual({ kind: 'idle' });
    });

    it('cancels a transcription in flight: the call is aborted and a late answer is ignored', async () => {
        let answer: (result: VoiceResult<TranscriptDraft>) => void = () => undefined;
        const { media, machine, transcribe, onDraft, request } = setup(
            () =>
                new Promise((resolve) => {
                    answer = resolve;
                }),
        );
        const recorder = await recording(media, machine, request);
        recorder.emit(new Blob(['speech']));
        machine.stop();
        machine.stop();
        await flush();
        expect(machine.state()).toEqual({ kind: 'transcribing' });
        machine.cancel();
        expect(transcribe.mock.calls[0]?.[1].aborted).toBe(true);
        expect(machine.state()).toEqual({ kind: 'idle' });
        answer(draft('Too late.'));
        await flush();
        expect(onDraft).not.toHaveBeenCalled();
        expect(machine.state()).toEqual({ kind: 'idle' });
    });

    it('treats an aborted transcription as cancelled', async () => {
        const { media, machine, onDraft, request } = setup(() => Promise.resolve({ kind: 'aborted' }));
        const recorder = await recording(media, machine, request);
        recorder.emit(new Blob(['speech']));
        machine.stop();
        await flush();
        expect(machine.state()).toEqual({ kind: 'idle' });
        expect(onDraft).not.toHaveBeenCalled();
    });

    it('ignores a second start while busy, and stop or cancel with nothing under way', async () => {
        const { media, machine, request } = setup();
        machine.stop();
        machine.cancel();
        expect(machine.state()).toEqual({ kind: 'idle' });
        await recording(media, machine, request);
        machine.start(request);
        await flush();
        expect(media.tracks).toHaveLength(1);
        machine.cancel();
        expect(media.liveTracks()).toBe(0);
        expect(media.recorders[0]?.state).toBe('inactive');
    });
});
