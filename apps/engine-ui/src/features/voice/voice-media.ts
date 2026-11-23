/**
 * The browser APIs voice needs, as a port: the composition root (or a test) injects them through `AppBrowser.voiceMedia`,
 * and without it the window's own are used.
 */

export interface VoiceTrack {
    stop(): void;
}

export interface VoiceStream {
    getTracks(): readonly VoiceTrack[];
}

export interface VoiceRecorderEvents {
    readonly onData: (chunk: Blob) => void;
    readonly onStop: () => void;
    readonly onError: () => void;
}

export interface VoiceRecorder {
    start(timesliceMs: number): void;
    /** Ends the recording; a last `onData` and then `onStop` follow. Does nothing once it has stopped. */
    stop(): void;
}

export interface VoiceMicrophone {
    isTypeSupported(mediaType: string): boolean;
    /** Asks for the microphone; rejects with the browser's `DOMException` (`NotAllowedError`, `NotFoundError` …). */
    open(): Promise<VoiceStream>;
    record(stream: VoiceStream, mediaType: string, events: VoiceRecorderEvents): VoiceRecorder;
}

export interface VoiceAudioOutput {
    /** Decodes the audio and starts it; rejects when the browser cannot decode it. */
    play(audio: ArrayBuffer, onEnded: () => void): Promise<void>;
    /** Stops playback and frees the output; `play` after it does nothing. */
    close(): void;
}

export interface VoiceSpeaker {
    canPlayType(mediaType: string): boolean;
    /** Call it from the member's click: browsers let audio start only from a user gesture. */
    open(): VoiceAudioOutput;
}

export interface VoiceMedia {
    /** `null` without `getUserMedia` (no secure context) or `MediaRecorder`. */
    readonly microphone: VoiceMicrophone | null;
    /** `null` without Web Audio. */
    readonly speaker: VoiceSpeaker | null;
    readonly now: () => number;
    /** Runs `callback` once after `ms`; the returned function cancels it. */
    readonly after: (ms: number, callback: () => void) => () => void;
}

/** Opus at this rate is about 240 KB a minute, far below `MAX_VOICE_CLIP_BYTES`, and plenty for speech. */
const CLIP_BITS_PER_SECOND = 32_000;

function windowMicrophone(): VoiceMicrophone | null {
    const devices = globalThis.navigator.mediaDevices as MediaDevices | undefined;
    if (devices === undefined || typeof globalThis.MediaRecorder !== 'function') return null;
    return {
        isTypeSupported: (mediaType) => MediaRecorder.isTypeSupported(mediaType),
        open: () =>
            devices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }),
        record(stream, mediaType, events) {
            if (!(stream instanceof MediaStream)) throw new TypeError('Not a stream from open()');
            const recorder = new MediaRecorder(stream, {
                mimeType: mediaType,
                audioBitsPerSecond: CLIP_BITS_PER_SECOND,
            });
            recorder.ondataavailable = (event) => {
                events.onData(event.data);
            };
            recorder.onstop = events.onStop;
            recorder.onerror = events.onError;
            return {
                start: (timesliceMs) => {
                    recorder.start(timesliceMs);
                },
                stop: () => {
                    if (recorder.state !== 'inactive') recorder.stop();
                },
            };
        },
    };
}

/**
 * Web Audio, never an `<audio>` with a `blob:` URL: the engine's CSP has no `media-src`, so `default-src 'self'` would
 * refuse one, and the contract (voice.ts, `SPEECH_FORMATS`) keeps it that way.
 */
function windowSpeaker(): VoiceSpeaker | null {
    if (typeof globalThis.AudioContext !== 'function') return null;
    let probe: HTMLAudioElement | undefined;
    return {
        canPlayType(mediaType) {
            probe ??= document.createElement('audio');
            return probe.canPlayType(mediaType) !== '';
        },
        open() {
            const context = new AudioContext();
            let source: AudioBufferSourceNode | null = null;
            let closed = false;
            return {
                async play(audio, onEnded) {
                    const buffer = await context.decodeAudioData(audio);
                    if (closed) return;
                    if (context.state === 'suspended') await context.resume();
                    source = context.createBufferSource();
                    source.buffer = buffer;
                    source.connect(context.destination);
                    source.onended = onEnded;
                    source.start();
                },
                close() {
                    if (closed) return;
                    closed = true;
                    if (source !== null) {
                        source.onended = null;
                        source.stop();
                    }
                    void context.close().catch(() => undefined);
                },
            };
        },
    };
}

export function createWindowVoiceMedia(): VoiceMedia {
    return {
        microphone: windowMicrophone(),
        speaker: windowSpeaker(),
        now: () => Date.now(),
        after(ms, callback) {
            const handle = globalThis.setTimeout(callback, ms);
            return () => {
                globalThis.clearTimeout(handle);
            };
        },
    };
}
