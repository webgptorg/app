import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { PushToTalkButton } from '../voice/push-to-talk-button';
import type { PushToTalkState } from '../voice/push-to-talk';
import { ReadAloudButton } from '../voice/read-aloud-button';
import { createSpeechPlayer } from '../voice/speech-player';
import type { ReadAloudState } from '../voice/speech-player';
import { useVoiceMedia, pickSpeechFormats } from '../voice/voice-support';

const noop = () => undefined;

const PUSH_TO_TALK: readonly (readonly [string, PushToTalkState, number])[] = [
    ['idle', { kind: 'idle' }, 0],
    ['starting', { kind: 'starting' }, 0],
    ['recording', { kind: 'recording', startedAt: 0 }, 12_000],
    ['near the limit', { kind: 'recording', startedAt: 0 }, 52_000],
    ['transcribing', { kind: 'transcribing' }, 0],
    ['microphone denied', { kind: 'failed', problem: 'microphone-denied' }, 0],
    ['nothing heard', { kind: 'failed', problem: 'nothing-heard' }, 0],
];

const READ_ALOUD: readonly (readonly [string, ReadAloudState])[] = [
    ['idle', { kind: 'idle' }],
    ['loading', { kind: 'loading' }],
    ['playing', { kind: 'playing' }],
    ['failed', { kind: 'failed', problem: 'speech-failed' }],
];

/** A quiet 16 kHz mono tone as WAV, so the demo plays real audio without an engine. */
function toneWav(ms: number): Blob {
    const rate = 16_000;
    const samples = Math.round((rate * ms) / 1000);
    const view = new DataView(new ArrayBuffer(44 + samples * 2));
    const ascii = (offset: number, text: string) => {
        for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, samples * 2, true);
    for (let index = 0; index < samples; index += 1) {
        view.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 2_000), true);
    }
    return new Blob([view.buffer], { type: 'audio/wav' });
}

/** The real player and the browser's Web Audio, with a tone instead of the engine: `test:csp` plays it under the CSP. */
function LiveReadAloud() {
    const speaker = useVoiceMedia().speaker;
    const [player] = useState(createSpeechPlayer);
    const state = useSyncExternalStore(player.subscribe, player.state);
    const toggle = () => {
        if (state.kind === 'loading' || state.kind === 'playing' || speaker === null) {
            player.stop();
            return;
        }
        player.play({
            speaker,
            formats: pickSpeechFormats(speaker),
            speak: (formats) =>
                Promise.resolve(
                    formats.includes('audio/wav')
                        ? { kind: 'ok', value: toneWav(1_500) }
                        : { kind: 'failed', problem: 'speech-format-refused' },
                ),
        });
    };
    return <ReadAloudButton state={state} onToggle={toggle} />;
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-h-10 flex-wrap items-center gap-4">
            <span className="meta w-32 shrink-0">{label}</span>
            {children}
        </div>
    );
}

/** engine-ui's voice building blocks in every state; not mounted in the product yet (features/voice/README.md). */
export function VoiceGallery() {
    return (
        <section aria-labelledby="gallery-voice" className="flex flex-col gap-4">
            <h2 id="gallery-voice" className="text-lg font-semibold">
                {'Voice (engine-ui)'}
            </h2>
            <h3 className="font-medium">{'PushToTalkButton'}</h3>
            {PUSH_TO_TALK.map(([label, state, elapsedMs]) => (
                <Row key={label} label={label}>
                    <PushToTalkButton
                        state={state}
                        elapsedMs={elapsedMs}
                        onStart={noop}
                        onStop={noop}
                        onCancel={noop}
                    />
                </Row>
            ))}
            <h3 className="font-medium">{'ReadAloudButton'}</h3>
            {READ_ALOUD.map(([label, state]) => (
                <Row key={label} label={label}>
                    <ReadAloudButton state={state} onToggle={noop} />
                </Row>
            ))}
            <Row label="too long">
                <ReadAloudButton state={{ kind: 'idle' }} onToggle={noop} disabledReason="Too long to read aloud." />
            </Row>
            <Row label="live (a tone)">
                <div data-voice-demo="">
                    <LiveReadAloud />
                </div>
            </Row>
        </section>
    );
}
