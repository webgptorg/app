import type {
    VoiceAudioOutput,
    VoiceMedia,
    VoiceRecorder,
    VoiceRecorderEvents,
    VoiceStream,
} from '../features/voice/voice-media';

export interface FakeTrack {
    stopped: boolean;
    stop(): void;
}

export interface FakeRecorder extends VoiceRecorder {
    readonly mediaType: string;
    readonly timesliceMs: number | null;
    readonly state: 'inactive' | 'recording';
    /** A chunk the recorder delivers now, as `dataavailable` does every timeslice. */
    emit(chunk: Blob): void;
    /** Fails the recording, as the browser's `error` event does. */
    fail(): void;
}

export interface FakeOutput extends VoiceAudioOutput {
    readonly played: readonly ArrayBuffer[];
    readonly closed: boolean;
    /** The audio has played to its end. */
    end(): void;
}

export interface FakeVoiceMediaOptions {
    /** What `MediaRecorder.isTypeSupported` says yes to; Chromium's Opus in WebM by default. */
    readonly recordable?: readonly string[];
    /** What `canPlayType` says yes to; MP3 and WAV by default. */
    readonly playable?: readonly string[];
    readonly microphone?: boolean;
    readonly speaker?: boolean;
}

export interface FakeVoiceMedia extends VoiceMedia {
    readonly tracks: readonly FakeTrack[];
    readonly recorders: readonly FakeRecorder[];
    readonly outputs: readonly FakeOutput[];
    /** The next `open()` rejects with a `DOMException` of this name, as `getUserMedia` does. */
    refuseMicrophone(name: string): void;
    /** The next `open()` waits for the member's answer; the returned function grants it. */
    holdMicrophone(): () => void;
    /** The final chunk each recorder delivers when it stops; none by default. */
    lastChunk: Blob | null;
    /** The next `record()` throws, as `new MediaRecorder` does for a type it cannot make. */
    refuseRecorder(): void;
    /** The next `play()` rejects, as `decodeAudioData` does for audio it cannot decode. */
    refuseDecode(): void;
    /** The next `speaker.open()` throws, as `new AudioContext` does when the browser has no audio output. */
    refuseOutput(): void;
    /** Moves the clock and runs what is due. */
    advance(ms: number): void;
    /** Tracks handed out and not stopped yet: the microphone is in use while this is above zero. */
    liveTracks(): number;
}

/** The voice port for tests: a microphone, a recorder, an audio output and a clock the test drives. */
export function createFakeVoiceMedia(options: FakeVoiceMediaOptions = {}): FakeVoiceMedia {
    const recordable = options.recordable ?? ['audio/webm;codecs=opus'];
    const playable = options.playable ?? ['audio/mpeg', 'audio/wav'];
    const tracks: FakeTrack[] = [];
    const recorders: FakeRecorder[] = [];
    const outputs: FakeOutput[] = [];
    let now = 0;
    let timers: { at: number; callback: () => void }[] = [];
    let nextOpen: { kind: 'refuse'; name: string } | { kind: 'hold' } | null = null;
    let grant: (() => void) | null = null;
    let refuseRecorder = false;
    let refuseDecode = false;
    let refuseOutput = false;

    const stream = (): VoiceStream => {
        const track: FakeTrack = {
            stopped: false,
            stop() {
                track.stopped = true;
            },
        };
        tracks.push(track);
        return { getTracks: () => [track] };
    };

    const media: FakeVoiceMedia = {
        tracks,
        recorders,
        outputs,
        lastChunk: null,
        microphone:
            options.microphone === false
                ? null
                : {
                      isTypeSupported: (mediaType) => recordable.includes(mediaType),
                      open() {
                          const next = nextOpen;
                          nextOpen = null;
                          if (next?.kind === 'refuse') {
                              return Promise.reject(new DOMException('refused', next.name));
                          }
                          if (next?.kind === 'hold') {
                              return new Promise((resolve) => {
                                  grant = () => {
                                      resolve(stream());
                                  };
                              });
                          }
                          return Promise.resolve(stream());
                      },
                      record(_stream, mediaType, events: VoiceRecorderEvents) {
                          if (refuseRecorder) {
                              refuseRecorder = false;
                              throw new DOMException('unsupported', 'NotSupportedError');
                          }
                          let state: 'inactive' | 'recording' = 'inactive';
                          let timesliceMs: number | null = null;
                          const recorder: FakeRecorder = {
                              mediaType,
                              get timesliceMs() {
                                  return timesliceMs;
                              },
                              get state() {
                                  return state;
                              },
                              start(slice) {
                                  state = 'recording';
                                  timesliceMs = slice;
                              },
                              stop() {
                                  if (state === 'inactive') return;
                                  state = 'inactive';
                                  const last = media.lastChunk;
                                  queueMicrotask(() => {
                                      if (last !== null) events.onData(last);
                                      events.onStop();
                                  });
                              },
                              emit: (chunk) => {
                                  events.onData(chunk);
                              },
                              fail: () => {
                                  state = 'inactive';
                                  events.onError();
                              },
                          };
                          recorders.push(recorder);
                          return recorder;
                      },
                  },
        speaker:
            options.speaker === false
                ? null
                : {
                      canPlayType: (mediaType) => playable.includes(mediaType),
                      open() {
                          if (refuseOutput) {
                              refuseOutput = false;
                              throw new DOMException('no output', 'NotSupportedError');
                          }
                          const played: ArrayBuffer[] = [];
                          let closed = false;
                          let ended: (() => void) | null = null;
                          const output: FakeOutput = {
                              played,
                              get closed() {
                                  return closed;
                              },
                              play(audio, onEnded) {
                                  if (refuseDecode) {
                                      refuseDecode = false;
                                      return Promise.reject(new DOMException('cannot decode', 'EncodingError'));
                                  }
                                  played.push(audio);
                                  ended = onEnded;
                                  return Promise.resolve();
                              },
                              close() {
                                  closed = true;
                                  ended = null;
                              },
                              end() {
                                  ended?.();
                              },
                          };
                          outputs.push(output);
                          return output;
                      },
                  },
        now: () => now,
        after(ms, callback) {
            const timer = { at: now + ms, callback };
            timers.push(timer);
            return () => {
                timers = timers.filter((other) => other !== timer);
            };
        },
        refuseMicrophone(name) {
            nextOpen = { kind: 'refuse', name };
        },
        holdMicrophone() {
            nextOpen = { kind: 'hold' };
            return () => {
                grant?.();
            };
        },
        refuseRecorder() {
            refuseRecorder = true;
        },
        refuseDecode() {
            refuseDecode = true;
        },
        refuseOutput() {
            refuseOutput = true;
        },
        advance(ms) {
            now += ms;
            const due = timers.filter((timer) => timer.at <= now);
            timers = timers.filter((timer) => timer.at > now);
            for (const timer of due) timer.callback();
        },
        liveTracks: () => tracks.filter((track) => !track.stopped).length,
    };
    return media;
}
