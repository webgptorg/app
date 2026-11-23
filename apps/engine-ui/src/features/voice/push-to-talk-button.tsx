import { MAX_VOICE_CLIP_MS } from '@ptbk/engine-api';
import { IconButton, StatusDot, VisuallyHidden } from '@ptbk/ui';
import type { ButtonSize } from '@ptbk/ui';
import { Mic, Square, X } from 'lucide-react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { formatClock } from '../chat/references/elapsed';
import { RECORDING_LIMIT_MS } from './push-to-talk';
import type { PushToTalkState } from './push-to-talk';
import { voiceProblemMessage } from './voice-problems';

/** In the last stretch the limit shows beside the time, so the recording stopping by itself is no surprise. */
const LIMIT_WARNING_MS = 10_000;

export interface PushToTalkButtonProps {
    readonly state: PushToTalkState;
    /** Time since the recording started; read only while recording. */
    readonly elapsedMs: number;
    readonly onStart: () => void;
    readonly onStop: () => void;
    readonly onCancel: () => void;
    /** While the composer cannot take text (a reply streams, a send is under way). */
    readonly disabled?: boolean;
    readonly size?: ButtonSize;
    readonly className?: string;
}

function RecordingClock({ elapsedMs }: { readonly elapsedMs: number }) {
    const shown = Math.min(Math.max(0, elapsedMs), MAX_VOICE_CLIP_MS);
    const nearLimit = elapsedMs >= RECORDING_LIMIT_MS - LIMIT_WARNING_MS;
    return (
        <span className={cx('meta inline-flex items-center gap-1.5', nearLimit && 'text-warning')}>
            <StatusDot tone="live" />
            {nearLimit
                ? m.voice_clock_of_limit({ time: formatClock(shown), limit: formatClock(MAX_VOICE_CLIP_MS) })
                : formatClock(shown)}
        </span>
    );
}

/**
 * The microphone button for the composer: start, then a running clock with Stop (transcribe) and Discard, then a
 * spinner while the engine transcribes. Presentational: `usePushToTalk` or `ComposerVoiceInput` drive it.
 */
export function PushToTalkButton({
    state,
    elapsedMs,
    onStart,
    onStop,
    onCancel,
    disabled = false,
    size = 'md',
    className,
}: PushToTalkButtonProps) {
    const discard = <IconButton icon={<X />} label={m.voice_discard()} size={size} onClick={onCancel} />;
    const record = (
        <IconButton icon={<Mic />} label={m.voice_dictate()} size={size} disabled={disabled} onClick={onStart} />
    );
    let body;
    switch (state.kind) {
        case 'idle':
            body = record;
            break;
        case 'failed':
            body = (
                <>
                    {record}
                    <span role="alert" className="max-w-72 text-xs text-danger">
                        {voiceProblemMessage(state.problem)}
                    </span>
                </>
            );
            break;
        case 'starting':
            body = <IconButton icon={<Mic />} label={m.voice_starting()} size={size} loading />;
            break;
        case 'recording':
            body = (
                <>
                    <RecordingClock elapsedMs={elapsedMs} />
                    {discard}
                    <IconButton
                        icon={<Square />}
                        label={m.voice_stop()}
                        variant="primary"
                        size={size}
                        onClick={onStop}
                    />
                </>
            );
            break;
        case 'transcribing':
            body = (
                <>
                    {discard}
                    <IconButton icon={<Mic />} label={m.voice_transcribing()} size={size} loading />
                </>
            );
            break;
    }
    return (
        <span className={cx('inline-flex items-center gap-1.5', className)}>
            {body}
            <VisuallyHidden role="status">
                {state.kind === 'recording'
                    ? m.voice_recording()
                    : state.kind === 'transcribing'
                      ? m.voice_transcribing()
                      : ''}
            </VisuallyHidden>
        </span>
    );
}
