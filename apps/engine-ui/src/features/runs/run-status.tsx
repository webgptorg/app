import type { ReadRun } from '@ptbk/engine-api';
import { Badge } from '@ptbk/ui';
import type { BadgeTone } from '@ptbk/ui';
import { Ban, CircleAlert, CircleCheck, CircleHelp, Hourglass, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';

/** A status this UI does not know yet (a newer engine's) reads as `unknown`, never as an error. */
export type RunStatusValue = ReadRun['status'];

interface StatusLook {
    readonly label: string;
    readonly tone: BadgeTone;
    readonly icon: ReactNode;
}

function lookOf(status: RunStatusValue): StatusLook {
    switch (status) {
        case 'queued':
            return { label: m.run_status_queued(), tone: 'info', icon: <Hourglass /> };
        case 'running':
            return { label: m.run_status_running(), tone: 'accent', icon: <Play /> };
        case 'completed':
            return { label: m.run_status_completed(), tone: 'success', icon: <CircleCheck /> };
        case 'failed':
            return { label: m.run_status_failed(), tone: 'danger', icon: <CircleAlert /> };
        case 'cancelled':
            return { label: m.run_status_cancelled(), tone: 'neutral', icon: <Ban /> };
        case 'unknown':
            return { label: m.run_status_unknown(), tone: 'neutral', icon: <CircleHelp /> };
    }
}

export function runStatusLabel(status: RunStatusValue): string {
    return lookOf(status).label;
}

const TERMINAL: ReadonlySet<RunStatusValue> = new Set(['completed', 'failed', 'cancelled']);

/**
 * The status as text with an icon, never colour alone. A running run breathes; one that finishes while on screen
 * settles once. Both come from motion tokens and stop under reduced motion.
 */
export function RunStatusBadge({
    status,
    cancelling = false,
}: {
    readonly status: RunStatusValue;
    readonly cancelling?: boolean;
}) {
    const look = lookOf(status);
    const previous = useRef(status);
    const [settling, setSettling] = useState(false);
    useEffect(() => {
        if (previous.current !== status && TERMINAL.has(status) && !TERMINAL.has(previous.current)) setSettling(true);
        previous.current = status;
    }, [status]);
    const label = cancelling && !TERMINAL.has(status) ? m.run_cancelling() : look.label;
    return (
        <span
            className={cx(
                'inline-flex',
                status === 'running' &&
                    !cancelling &&
                    'motion-safe:animate-[ptbk-run-breathe_var(--motion-live)_var(--ease-standard)_infinite]',
                settling && 'motion-safe:animate-[ptbk-run-settle_var(--motion-seal)_var(--ease-enter)]',
            )}
            onAnimationEnd={() => {
                setSettling(false);
            }}
        >
            <Badge tone={cancelling && !TERMINAL.has(status) ? 'warning' : look.tone} icon={look.icon}>
                {label}
            </Badge>
        </span>
    );
}
