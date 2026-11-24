import { EngineVersion } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { createMemoryLogger } from '../../testing/memory-logger';
import type { Random } from '../random';
import type { UiUpdateOutcome } from './ui-update';
import { ELIGIBLE_RECHECK_JITTER_MS, createUiUpdater } from './ui-updater';

const HOUR = 3_600_000;
const VERSION = EngineVersion.parse('1.1.0');
const MINUTE = 60_000;
const ZERO_RANDOM: Random = { bytes: (length) => new Uint8Array(length) };
const MAX_RANDOM: Random = { bytes: (length) => new Uint8Array(length).fill(0xff) };

function setup(
    options: {
        readonly automatic?: boolean;
        readonly random?: Random;
        readonly check?: (signal: AbortSignal) => Promise<UiUpdateOutcome>;
    } = {},
) {
    const clock = createFakeClock(0);
    const logger = createMemoryLogger();
    const calls: number[] = [];
    const updater = createUiUpdater({
        clock,
        logger,
        random: options.random ?? ZERO_RANDOM,
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

const delayed = (eligibleAtMs: number): UiUpdateOutcome => ({
    kind: 'refused',
    version: VERSION,
    reason: 'delay-not-elapsed',
    eligibleAt: new Date(eligibleAtMs),
});
const installed: UiUpdateOutcome = { kind: 'installed', version: VERSION, sha256: 'ab'.repeat(32) };

/** An updater whose checks answer `outcomes` in turn (the last one repeats), recording when each check ran. */
function scripted(
    outcomes: readonly UiUpdateOutcome[],
    options: { readonly automatic?: boolean; readonly random?: Random } = {},
) {
    const remaining = [...outcomes];
    const world = setup({
        ...options,
        check: () => {
            world.calls.push(world.clock.nowMs());
            const next = remaining.length > 1 ? remaining.shift() : remaining[0];
            return Promise.resolve(next ?? { kind: 'unavailable' });
        },
    });
    return world;
}

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

    it('checks again when a delayed release becomes eligible, on top of the interval', async () => {
        const { clock, calls, updater } = scripted([delayed(90 * MINUTE), delayed(90 * MINUTE), installed]);
        updater.start();
        await flush();
        clock.advance(HOUR);
        await flush();
        clock.advance(30 * MINUTE);
        await flush();
        expect(calls).toEqual([0, HOUR, 90 * MINUTE]);
        clock.advance(30 * MINUTE);
        await flush();
        expect(calls).toEqual([0, HOUR, 90 * MINUTE, 2 * HOUR]);
        await updater.stop();
        expect(clock.pendingTimers()).toBe(0);
    });

    it('adds at most a few seconds of jitter to the extra check', async () => {
        const { clock, calls, updater } = scripted([delayed(5 * MINUTE), installed], {
            automatic: true,
            random: MAX_RANDOM,
        });
        await updater.checkNow();
        expect(clock.nextTimerInMs()).toBe(5 * MINUTE + ELIGIBLE_RECHECK_JITTER_MS);
        clock.advance(5 * MINUTE + ELIGIBLE_RECHECK_JITTER_MS);
        await flush();
        expect(calls).toEqual([0, 5 * MINUTE + ELIGIBLE_RECHECK_JITTER_MS]);
    });

    it('keeps one extra check: a newer refusal replaces it', async () => {
        const { clock, calls, updater } = scripted([delayed(30 * MINUTE), delayed(40 * MINUTE), installed]);
        await updater.checkNow();
        await updater.checkNow();
        expect(clock.pendingTimers()).toBe(1);
        clock.advance(30 * MINUTE);
        await flush();
        expect(calls).toEqual([0, 0]);
        clock.advance(10 * MINUTE);
        await flush();
        expect(calls).toEqual([0, 0, 40 * MINUTE]);
        expect(clock.pendingTimers()).toBe(0);
    });

    it('drops the extra check after a check that is not a delay refusal', async () => {
        const { clock, calls, updater } = scripted([delayed(30 * MINUTE), installed]);
        await updater.checkNow();
        expect(clock.pendingTimers()).toBe(1);
        await updater.checkNow();
        expect(clock.pendingTimers()).toBe(0);
        clock.advance(HOUR);
        await flush();
        expect(calls).toEqual([0, 0]);
    });

    it('never rechecks at once for a release already past eligibleAt', async () => {
        const { clock, updater } = scripted([delayed(0)]);
        await updater.checkNow();
        expect(clock.pendingTimers()).toBe(0);
    });

    it('schedules no extra check under manual', async () => {
        const { clock, updater } = scripted([delayed(30 * MINUTE)], { automatic: false });
        await updater.checkNow();
        expect(clock.pendingTimers()).toBe(0);
    });

    describe('for updates@1', () => {
        it('reports the next check: due at start, then an interval after each check, or earlier at eligibleAt', async () => {
            const { clock, updater } = scripted([{ kind: 'up-to-date', version: VERSION }, delayed(10 * MINUTE)]);
            expect(updater.nextCheckAtMs()).toBeNull();
            updater.start();
            expect(updater.nextCheckAtMs()).toBe(0);
            await flush();
            expect(updater.nextCheckAtMs()).toBe(HOUR);
            clock.advance(5 * MINUTE);
            await updater.checkEarly();
            expect(updater.nextCheckAtMs()).toBe(10 * MINUTE);
            await updater.stop();
            expect(updater.nextCheckAtMs()).toBeNull();
        });

        it('schedules nothing under manual', () => {
            const { updater } = setup({ automatic: false });
            updater.start();
            expect(updater.nextCheckAtMs()).toBeNull();
        });

        it('joins a check in flight instead of running a second one', async () => {
            let release: (outcome: UiUpdateOutcome) => void = () => undefined;
            let runs = 0;
            const { updater } = setup({
                check: () => {
                    runs++;
                    return new Promise((resolve) => {
                        release = resolve;
                    });
                },
            });
            const first = updater.checkNow();
            await flush();
            const joined = updater.checkEarly();
            release(installed);
            expect(await joined).toBe(await first);
            expect(runs).toBe(1);
            const second = updater.checkEarly();
            await flush();
            release(installed);
            await second;
            expect(runs).toBe(2);
        });
    });
});
