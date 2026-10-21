import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { createMemoryLogger } from '../../testing/memory-logger';
import type { UiUpdateOutcome } from './ui-update';
import { createUiUpdater } from './ui-updater';

const HOUR = 3_600_000;

function setup(
    options: { readonly automatic?: boolean; readonly check?: (signal: AbortSignal) => Promise<UiUpdateOutcome> } = {},
) {
    const clock = createFakeClock(0);
    const logger = createMemoryLogger();
    const calls: number[] = [];
    const updater = createUiUpdater({
        clock,
        logger,
        intervalMs: HOUR,
        automatic: options.automatic ?? true,
        check:
            options.check ??
            (() => {
                calls.push(clock.nowMs());
                return Promise.resolve({ kind: 'unavailable' });
            }),
    });
    return { clock, logger, calls, updater };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createUiUpdater', () => {
    it('checks at start and then every interval', async () => {
        const { clock, calls, updater } = setup();
        updater.start();
        await flush();
        expect(calls).toEqual([0]);
        clock.advance(HOUR);
        await flush();
        clock.advance(HOUR);
        await flush();
        expect(calls).toEqual([0, HOUR, 2 * HOUR]);
        await updater.stop();
        clock.advance(HOUR);
        await flush();
        expect(calls).toHaveLength(3);
    });

    it('does not check on its own under manual, only when asked', async () => {
        const { clock, calls, updater } = setup({ automatic: false });
        updater.start();
        clock.advance(10 * HOUR);
        await flush();
        expect(calls).toEqual([]);
        expect(await updater.checkNow()).toEqual({ kind: 'unavailable' });
        expect(updater.lastOutcome()).toEqual({ kind: 'unavailable' });
        expect(calls).toHaveLength(1);
    });

    it('never runs two checks at once', async () => {
        let running = 0;
        let most = 0;
        const { updater } = setup({
            automatic: false,
            check: async () => {
                running++;
                most = Math.max(most, running);
                await flush();
                running--;
                return { kind: 'up-to-date', version: '1.0.0' } as UiUpdateOutcome;
            },
        });
        await Promise.all([updater.checkNow(), updater.checkNow(), updater.checkNow()]);
        expect(most).toBe(1);
    });

    it('turns a broken check into unavailable and logs only the error name', async () => {
        const { logger, updater } = setup({
            automatic: false,
            check: () => Promise.reject(new RangeError('disk /secret path full')),
        });
        expect(await updater.checkNow()).toEqual({ kind: 'unavailable' });
        expect(logger.entries).toEqual([
            { level: 'error', event: 'ui.check-failed', fields: { problem: 'RangeError' } },
        ]);
        expect(logger.text()).not.toContain('secret');
    });

    it('aborts a check in flight on stop without logging it as a failure', async () => {
        const { logger, updater } = setup({
            automatic: false,
            check: (signal) =>
                new Promise((_, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(signal.reason as Error);
                    });
                }),
        });
        const pending = updater.checkNow();
        await flush();
        await updater.stop();
        expect(await pending).toEqual({ kind: 'unavailable' });
        expect(await updater.checkNow()).toEqual({ kind: 'unavailable' });
        expect(logger.entries).toEqual([]);
    });
});
