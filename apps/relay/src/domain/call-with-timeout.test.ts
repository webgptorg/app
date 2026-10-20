import { describe, expect, it } from 'vitest';

import { createTestDeps } from '../testing/test-deps';
import { callWithTimeout } from './call-with-timeout';

describe('callWithTimeout', () => {
    it('turns a synchronous throw into an outcome', async () => {
        const { clock } = createTestDeps();
        await expect(
            callWithTimeout(clock, 10, () => {
                throw new Error('bug');
            }),
        ).resolves.toEqual({ kind: 'threw' });
        expect(clock.pendingTimers()).toBe(0);
    });

    it('ignores a result that arrives after the timeout', async () => {
        const { clock } = createTestDeps();
        let finish: (value: string) => void = () => undefined;
        let seen: AbortSignal | undefined;
        const outcome = callWithTimeout(clock, 10, (signal) => {
            seen = signal;
            return new Promise<string>((resolve) => (finish = resolve));
        });
        await Promise.resolve();
        clock.advance(10);
        finish('late');
        await expect(outcome).resolves.toEqual({ kind: 'timeout' });
        expect(seen?.aborted).toBe(true);
    });
});
