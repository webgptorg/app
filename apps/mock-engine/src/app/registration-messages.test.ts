import { REGISTRATION_ERROR_CODE } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { RegistrationOutcome, RegistrationRejection, UnavailableReason } from '../domain/registration/register';
import { EXIT_CODE } from './exit-codes';
import { formatDelay, registrationExitCode, registrationSentence, retrySentence } from './registration-messages';

const REJECTIONS = Object.values(REGISTRATION_ERROR_CODE).filter(
    (code): code is RegistrationRejection => code !== 'rate-limited',
);

describe('registrationExitCode', () => {
    it('gives each class its own code (installation.md)', () => {
        const expected: Readonly<Record<RegistrationRejection, number>> = {
            'invalid-link-code': EXIT_CODE.linkCodeRefused,
            'engine-exists': EXIT_CODE.identityRefused,
            'engine-suspended': EXIT_CODE.identityRefused,
            'engine-limit': EXIT_CODE.plan,
            'not-entitled': EXIT_CODE.plan,
            'bad-signature': EXIT_CODE.answerRefused,
        };
        for (const reason of REJECTIONS) {
            expect(registrationExitCode({ kind: 'rejected', reason }), reason).toBe(expected[reason]);
        }
        expect(registrationExitCode({ kind: 'unavailable', reason: 'rate-limited' })).toBe(EXIT_CODE.unreachable);
        expect(registrationExitCode({ kind: 'refused-response', reason: 'hostname-mismatch' })).toBe(
            EXIT_CODE.answerRefused,
        );
    });
});

describe('registrationSentence', () => {
    it('says the same for engine-limit and not-entitled, and points to billing', () => {
        const limit = registrationSentence({ kind: 'rejected', reason: 'engine-limit' });
        expect(registrationSentence({ kind: 'rejected', reason: 'not-entitled' })).toBe(limit);
        expect(limit).toContain('Billing at app.ptbk.io');
    });

    it('names a next step for every failure', () => {
        const failures: RegistrationOutcome[] = [
            ...REJECTIONS.map((reason) => ({ kind: 'rejected' as const, reason })),
            { kind: 'refused-response', reason: 'engine-id-mismatch' },
            { kind: 'unavailable', reason: 'no-answer' },
        ];
        for (const outcome of failures) {
            expect(registrationSentence(outcome)).toMatch(/\.$/);
        }
        expect(registrationSentence({ kind: 'rejected', reason: 'invalid-link-code' })).toContain(
            '`mock-engine connect --link <new code>`',
        );
    });
});

describe('retrySentence', () => {
    it('says when the next try is and why', () => {
        const reasons: UnavailableReason[] = ['no-answer', 'error-status', 'unknown-code'];
        for (const reason of reasons) {
            expect(retrySentence({ reason, attempt: 1, delayMs: 5_000 })).toMatch(
                /^Cannot reach the Promptbook platform \(.+\)\. Retrying in 5 s;/,
            );
        }
        expect(retrySentence({ reason: 'rate-limited', attempt: 3, delayMs: 120_000 })).toBe(
            'The platform is busy; retrying in 2 min.',
        );
    });

    it('rounds delays for people', () => {
        expect(formatDelay(0)).toBe('1 s');
        expect(formatDelay(89_000)).toBe('89 s');
        expect(formatDelay(95_000)).toBe('2 min');
    });
});
