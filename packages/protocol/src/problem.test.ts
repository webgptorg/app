import { describe, expect, it } from 'vitest';
import { ProblemDetails, REGISTRATION_ERROR_CODE, TolerantProblemDetails } from './problem';

const problem = {
    type: 'https://ptbk.io/problems/invalid-link-code',
    title: 'Invalid link code',
    status: 401,
    code: REGISTRATION_ERROR_CODE.invalidLinkCode,
};

describe('ProblemDetails', () => {
    it('accepts a problem with and without the optional members', () => {
        expect(ProblemDetails.parse(problem)).toEqual(problem);
        const stale = { ...problem, code: 'stale-timestamp', detail: 'Clock skew', serverTime: '2026-10-16T12:00:00Z' };
        expect(ProblemDetails.parse(stale)).toEqual(stale);
    });

    it.each([
        ['an unknown member', { ...problem, stack: 'Error: at …' }],
        ['a 2xx status', { ...problem, status: 200 }],
        ['a fractional status', { ...problem, status: 401.5 }],
        ['an uppercase code', { ...problem, code: 'Invalid-Link-Code' }],
        ['a code with a trailing hyphen', { ...problem, code: 'invalid-' }],
        ['a 65-character code', { ...problem, code: 'a'.repeat(65) }],
        ['an empty title', { ...problem, title: '' }],
        ['a non-UTC serverTime', { ...problem, serverTime: '2026-10-16T12:00:00+02:00' }],
        ['a missing code', { type: problem.type, title: problem.title, status: problem.status }],
    ])('rejects %s', (_, value) => {
        expect(ProblemDetails.safeParse(value).success).toBe(false);
    });

    it('lists the registration codes', () => {
        expect(Object.values(REGISTRATION_ERROR_CODE)).toEqual([
            'invalid-link-code',
            'engine-exists',
            'engine-suspended',
            'engine-limit',
            'bad-signature',
        ]);
        for (const code of Object.values(REGISTRATION_ERROR_CODE)) {
            expect(ProblemDetails.safeParse({ ...problem, code }).success).toBe(true);
        }
    });
});

describe('TolerantProblemDetails', () => {
    it('strips unknown members', () => {
        expect(TolerantProblemDetails.parse({ ...problem, retryAfter: 30 })).toEqual(problem);
    });

    it('still validates known members', () => {
        expect(TolerantProblemDetails.safeParse({ ...problem, status: 200, extra: true }).success).toBe(false);
        expect(TolerantProblemDetails.safeParse({ ...problem, serverTime: 'yesterday' }).success).toBe(false);
    });
});
