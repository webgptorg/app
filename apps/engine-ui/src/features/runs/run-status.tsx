import type { ReadRun } from '@ptbk/engine-api';
import { Badge } from '@ptbk/ui';
import type { BadgeTone } from '@ptbk/ui';
import { CircleAlert, CircleCheck, CircleHelp, CircleStop, Hourglass, Play } from 'lucide-react';
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
            return { label: m.run_status_cancelled(), tone: 'neutral', icon: <CircleStop /> };
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
    const stopping = cancelling && !TERMINAL.has(status);
    // The badge text never fades (it must keep its contrast); a decorative dot beside it carries the breathing.
    return (
        <span
            className={cx(
                'inline-flex items-center gap-1.5',
                settling && 'motion-safe:animate-[ptbk-run-settle_var(--motion-seal)_var(--ease-enter)]',
            )}
            onAnimationEnd={() => {
                setSettling(false);
            }}
        >
            {status === 'running' && !stopping ? (
                <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-pill bg-live motion-safe:animate-[ptbk-breathe_var(--motion-live)_var(--ease-standard)_infinite]"
                />
            ) : null}
            {stopping ? (
                <Badge tone="warning" icon={<CircleStop />}>
                    {m.run_stopping()}
                </Badge>
            ) : (
                <Badge tone={look.tone} icon={look.icon}>
                    {look.label}
                </Badge>
            )}
        </span>
    );
}
