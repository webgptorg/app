import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWindowVoiceMedia } from './voice-media';

class FakeMediaStream {
    readonly track = { stop: vi.fn() };
    getTracks() {
        return [this.track];
    }
}

class FakeMediaRecorder {
    static readonly isTypeSupported = vi.fn((type: string) => type === 'audio/webm;codecs=opus');
    static readonly made: FakeMediaRecorder[] = [];
    state: 'inactive' | 'recording' = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readonly start = vi.fn(() => {
        this.state = 'recording';
    });
    readonly stop = vi.fn(() => {
        this.state = 'inactive';
    });
    readonly options: unknown;
    constructor(_stream: unknown, options: unknown) {
        this.options = options;
        FakeMediaRecorder.made.push(this);
    }
}

class FakeAudioContext {
    static readonly made: FakeAudioContext[] = [];
    state = 'suspended';
    readonly destination = {};
    readonly source = {
        buffer: null as unknown,
        onended: null as unknown,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
    };
    readonly decodeAudioData = vi.fn(() => Promise.resolve({ duration: 1 }));
    readonly resume = vi.fn(() => {
        this.state = 'running';
        return Promise.resolve();
    });
    readonly close = vi.fn(() => Promise.resolve());
    readonly createBufferSource = vi.fn(() => this.source);
    constructor() {
        FakeAudioContext.made.push(this);
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
    FakeMediaRecorder.made.length = 0;
    FakeAudioContext.made.length = 0;
});

describe('the window voice media', () => {
    it('has no microphone or speaker where the browser lacks the APIs', () => {
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('MediaRecorder', undefined);
        vi.stubGlobal('AudioContext', undefined);
        const media = createWindowVoiceMedia();
        expect(media.microphone).toBeNull();
        expect(media.speaker).toBeNull();
    });

    it('records through MediaRecorder at the speech bitrate and wires its events', async () => {
        const stream = new FakeMediaStream();
        const getUserMedia = vi.fn(() => Promise.resolve(stream));
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('MediaStream', FakeMediaStream);
        const microphone = createWindowVoiceMedia().microphone;
        if (microphone === null) throw new Error('expected a microphone');

        expect(microphone.isTypeSupported('audio/webm;codecs=opus')).toBe(true);
        expect(microphone.isTypeSupported('audio/mp4')).toBe(false);
        const opened = await microphone.open();
        expect(getUserMedia.mock.calls[0]).toEqual([
            { audio: expect.objectContaining({ channelCount: 1 }) as unknown },
        ]);

        const events = { onData: vi.fn(), onStop: vi.fn(), onError: vi.fn() };
        const recorder = microphone.record(opened, 'audio/webm;codecs=opus', events);
        const native = FakeMediaRecorder.made[0];
        expect(native?.options).toEqual({ mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 });
        recorder.start(1_000);
        expect(native?.start).toHaveBeenCalledWith(1_000);
        const chunk = new Blob(['x']);
        native?.ondataavailable?.({ data: chunk });
        expect(events.onData).toHaveBeenCalledWith(chunk);
        native?.onerror?.();
        expect(events.onError).toHaveBeenCalled();
        recorder.stop();
        recorder.stop();
        expect(native?.stop).toHaveBeenCalledOnce();
        native?.onstop?.();
        expect(events.onStop).toHaveBeenCalled();

        expect(() => microphone.record({ getTracks: () => [] }, 'audio/webm;codecs=opus', events)).toThrow(TypeError);
    });

    it('plays through Web Audio, resuming a suspended context, and stops and closes it', async () => {
        vi.stubGlobal('AudioContext', FakeAudioContext);
        const speaker = createWindowVoiceMedia().speaker;
        if (speaker === null) throw new Error('expected a speaker');
        expect(speaker.canPlayType('audio/wav')).toBe(false);

        const output = speaker.open();
        const context = FakeAudioContext.made[0];
        if (context === undefined) throw new Error('expected an audio context');
        const onEnded = vi.fn();
        await output.play(new ArrayBuffer(8), onEnded);
        expect(context.resume).toHaveBeenCalled();
        expect(context.source.start).toHaveBeenCalled();
        expect(context.source.connect).toHaveBeenCalledWith(context.destination);
        expect(context.source.onended).toBe(onEnded);

        output.close();
        output.close();
        expect(context.source.stop).toHaveBeenCalledOnce();
        expect(context.close).toHaveBeenCalledOnce();
    });

    it('starts nothing when closed while decoding', async () => {
        vi.stubGlobal('AudioContext', FakeAudioContext);
        const output = createWindowVoiceMedia().speaker?.open();
        const context = FakeAudioContext.made[0];
        if (context === undefined) throw new Error('expected an audio context');
        const playing = output?.play(new ArrayBuffer(8), vi.fn());
        output?.close();
        await playing;
        expect(context.createBufferSource).not.toHaveBeenCalled();
        expect(context.source.stop).not.toHaveBeenCalled();
    });

    it('keeps time with the window clock', () => {
        vi.useFakeTimers();
        try {
            const media = createWindowVoiceMedia();
            const done = vi.fn();
            const cancelled = vi.fn();
            media.after(100, done);
            media.after(100, cancelled)();
            vi.advanceTimersByTime(100);
            expect(done).toHaveBeenCalledOnce();
            expect(cancelled).not.toHaveBeenCalled();
            expect(media.now()).toBe(Date.now());
        } finally {
            vi.useRealTimers();
        }
    });
});
