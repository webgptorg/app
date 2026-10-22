import { describe, expect, it, vi } from 'vitest';

import { ANNOUNCE_INTERVAL_MS, createAnnouncer } from './activity-announcer';

function setup() {
    let now = 0;
    const timers: { at: number; callback: () => void }[] = [];
    const announce = vi.fn<(lines: readonly string[]) => void>();
    const announcer = createAnnouncer({
        now: () => now,
        setTimeout: (callback, ms) => {
            const timer = { at: now + ms, callback };
            timers.push(timer);
            return timer;
        },
        clearTimeout: (handle) => {
            timers.splice(timers.indexOf(handle as (typeof timers)[number]), 1);
        },
        announce,
    });
    const advance = (ms: number) => {
        now += ms;
        for (const timer of timers.filter(({ at }) => at <= now)) {
            timers.splice(timers.indexOf(timer), 1);
            timer.callback();
        }
    };
    return { announcer, announce, advance, timers };
}

describe('the activity announcer', () => {
    it('announces what arrives together as one batch', () => {
        const { announcer, announce, advance } = setup();
        announcer.push(['a']);
        announcer.push(['b', 'c']);
        expect(announce).not.toHaveBeenCalled();
        advance(0);
        expect(announce).toHaveBeenCalledExactlyOnceWith(['a', 'b', 'c']);
    });

    it(`waits ${String(ANNOUNCE_INTERVAL_MS / 1000)} s after an announcement, then sends everything since as one`, () => {
        const { announcer, announce, advance } = setup();
        announcer.push(['first']);
        advance(0);
        advance(1_000);
        announcer.push(['second']);
        advance(1_000);
        announcer.push(['third']);
        advance(ANNOUNCE_INTERVAL_MS - 2_001);
        expect(announce).toHaveBeenCalledTimes(1);
        advance(1);
        expect(announce).toHaveBeenLastCalledWith(['second', 'third']);
        expect(announce).toHaveBeenCalledTimes(2);
    });

    it('ignores empty batches and drops what is pending when disposed', () => {
        const { announcer, announce, advance, timers } = setup();
        announcer.push([]);
        expect(timers).toHaveLength(0);
        announcer.push(['lost']);
        announcer.dispose();
        advance(ANNOUNCE_INTERVAL_MS);
        expect(announce).not.toHaveBeenCalled();
        announcer.dispose();
    });
});
