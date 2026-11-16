import { describe, expect, it } from 'vitest';

import { HOME_GUIDE_STEPS, nextHomeGuide, walletNeedsSetup } from './home-guide-steps';
import type { HomeGuideStep, StepState } from './home-guide-steps';

const allDone: Record<HomeGuideStep, StepState> = {
    'create-agent': { pending: false },
    'set-up-wallet': { pending: false },
    'invite-colleague': { pending: false },
    'ask-chatter': { pending: false },
};

describe('nextHomeGuide', () => {
    it.each(HOME_GUIDE_STEPS)('offers %s when it is the only step left', (step) => {
        expect(nextHomeGuide({ ...allDone, [step]: { pending: true } }, false)).toEqual({ kind: 'step', step });
    });

    it('offers only the first step that waits, in order', () => {
        expect(
            nextHomeGuide(
                { ...allDone, 'invite-colleague': { pending: true }, 'ask-chatter': { pending: true } },
                false,
            ),
        ).toEqual({ kind: 'step', step: 'invite-colleague' });
    });

    it('skips steps the member cannot take', () => {
        expect(
            nextHomeGuide(
                {
                    'create-agent': null,
                    'set-up-wallet': null,
                    'invite-colleague': null,
                    'ask-chatter': { pending: true },
                },
                false,
            ),
        ).toEqual({ kind: 'step', step: 'ask-chatter' });
    });

    it('waits for an earlier step before offering a later one', () => {
        expect(
            nextHomeGuide(
                { ...allDone, 'create-agent': { pending: undefined }, 'ask-chatter': { pending: true } },
                false,
            ),
        ).toEqual({ kind: 'loading' });
        expect(
            nextHomeGuide(
                { ...allDone, 'set-up-wallet': { pending: true }, 'ask-chatter': { pending: undefined } },
                false,
            ),
        ).toEqual({ kind: 'step', step: 'set-up-wallet' });
    });

    it('turns into a dismissible tip when all is done, and stays away once dismissed', () => {
        expect(nextHomeGuide(allDone, false)).toEqual({ kind: 'done' });
        expect(nextHomeGuide(allDone, true)).toEqual({ kind: 'hidden' });
        expect(nextHomeGuide({ ...allDone, 'create-agent': { pending: true } }, true)).toEqual({
            kind: 'step',
            step: 'create-agent',
        });
    });
});

describe('walletNeedsSetup', () => {
    it.each([
        ['empty', 0, 0, true],
        ['setup', 0, 0, true],
        ['ready', 0, 0, true],
        ['ready', 1, 0, false],
        ['ready', 0, 2, false],
        ['locked', 0, 3, false],
        ['unavailable', 0, 0, false],
        ['unknown', 0, 0, false],
    ] as const)('%s with %i logins and %i locked: %s', (state, records, lockedRecords, expected) => {
        expect(walletNeedsSetup({ state, records: Array.from({ length: records }), lockedRecords })).toBe(expected);
    });
});
