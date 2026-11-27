import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { LIVE_BROWSER_TICK_MS, startLiveBrowserTicks, withLiveBrowser } from './live-browser';

describe('withLiveBrowser', () => {
    it('adds browser-tab@1 once', () => {
        const { tasks, browserTab } = KNOWN_CAPABILITIES;
        expect(withLiveBrowser([tasks])).toEqual([tasks, browserTab]);
        expect(withLiveBrowser([tasks, browserTab])).toEqual([tasks, browserTab]);
    });
});

describe('startLiveBrowserTicks', () => {
    it('ticks on the clock until stopped', () => {
        const clock = createFakeClock();
        let ticks = 0;
        const stop = startLiveBrowserTicks(clock, () => {
            ticks++;
        });
        clock.advance(LIVE_BROWSER_TICK_MS * 3);
        expect(ticks).toBe(3);
        stop();
        clock.advance(LIVE_BROWSER_TICK_MS * 3);
        expect(ticks).toBe(3);
        expect(clock.pendingTimers()).toBe(0);
    });

    it('keeps ticking after a tick threw', () => {
        const clock = createFakeClock();
        let ticks = 0;
        const stop = startLiveBrowserTicks(clock, () => {
            ticks++;
            if (ticks === 1) throw new Error('boom');
        });
        expect(() => {
            clock.advance(LIVE_BROWSER_TICK_MS);
        }).toThrow('boom');
        clock.advance(LIVE_BROWSER_TICK_MS);
        expect(ticks).toBe(2);
        stop();
    });

    it('does not tick again when stopped from inside a tick', () => {
        const clock = createFakeClock();
        let ticks = 0;
        const stop: () => void = startLiveBrowserTicks(clock, () => {
            ticks++;
            stop();
        });
        clock.advance(LIVE_BROWSER_TICK_MS * 3);
        expect(ticks).toBe(1);
        expect(clock.pendingTimers()).toBe(0);
    });
});
