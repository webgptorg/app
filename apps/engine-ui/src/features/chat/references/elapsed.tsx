import { useNow } from '../../../app/ticker';

/** A stopwatch reading: `0:08`, `4:12`, `1:03:27`. Language-neutral, so it sits in mono meta lines as is. */
export function formatClock(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    return hours > 0
        ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${String(minutes)}:${seconds}`;
}

/** Milliseconds from `from` to `to`, or to now (ticking) while `to` is `null`; `null` for a time that does not parse. */
export function useElapsedMs(from: string, to: string | null = null): number | null {
    const now = useNow();
    const start = Date.parse(from);
    const end = to === null ? now : Date.parse(to);
    return Number.isNaN(start) || Number.isNaN(end) ? null : end - start;
}
