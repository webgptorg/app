import { IconButton } from '@ptbk/ui';
import type { ButtonSize } from '@ptbk/ui';
import { Square, Volume2 } from 'lucide-react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import type { ReadAloudState } from './speech-player';
import { voiceProblemMessage } from './voice-problems';

export interface ReadAloudButtonProps {
    readonly state: ReadAloudState;
    /** Starts reading, or stops a reading that is playing. */
    readonly onToggle: () => void;
    /** Why this message cannot be read aloud (too long); the button stays focusable and says so. */
    readonly disabledReason?: string | undefined;
    readonly size?: ButtonSize;
    readonly className?: string;
}

/** A quiet speaker button for a message's actions. Presentational: `useReadAloud` or `MessageReadAloud` drive it. */
export function ReadAloudButton({ state, onToggle, disabledReason, size = 'sm', className }: ReadAloudButtonProps) {
    const playing = state.kind === 'playing';
    const label =
        state.kind === 'loading' ? m.voice_preparing() : playing ? m.voice_stop_reading() : m.voice_read_aloud();
    return (
        <span className={cx('inline-flex items-center gap-1.5', className)}>
            <IconButton
                icon={playing ? <Square /> : <Volume2 />}
                label={label}
                size={size}
                loading={state.kind === 'loading'}
                {...(disabledReason === undefined ? {} : { disabled: true, disabledReason })}
                onClick={onToggle}
            />
            {state.kind === 'failed' ? (
                <span role="alert" className="max-w-72 text-xs text-danger">
                    {voiceProblemMessage(state.problem)}
                </span>
            ) : null}
        </span>
    );
}
