import { describe, expect, it } from 'vitest';

import { checkLicense, type LicenseEnforcement } from './license-checks';
import type { LicenseGrant, LicenseRead } from './license-contract';

const now = Date.parse('2026-11-20T12:00:00.000Z');
const DAY = 86_400_000;

function grant(validUntil: string | null = null, engineProjects: number | null = 1): LicenseGrant {
    return {
        id: '4408b4d6-6005-4b77-97eb-fdd67847ee93',
        validFrom: new Date(now - 10 * DAY).toISOString(),
        validUntil,
        capabilities: {
            engineProjects,
            specialists: 10,
            controllingUsers: 3,
            harnessInstances: null,
            browserProfiles: 5,
            remoteControl: true,
        },
    };
}

function read(kind: 'current' | 'stale', grants: readonly LicenseGrant[]): LicenseRead {
    return {
        kind,
        license: {
            snapshot: {
                version: 1,
                subject: '4408b4d6-6005-4b77-97eb-fdd67847ee92',
                generatedAt: new Date(now - 60_000).toISOString(),
                refreshAfterSeconds: 900,
                enforcement: 'advisory',
                manageUrl: 'https://www.ptbk.io/cs/pricing/predplatne',
                grants: [...grants],
            },
            status: null,
            label: null,
        },
    };
}

const ONE_ENGINE = { engines: 1, people: 2 };

function check(
    mode: LicenseEnforcement,
    input: Partial<Omit<Parameters<typeof checkLicense>[0], 'mode'>> = {},
): ReturnType<typeof checkLicense> {
    return checkLicense({
        point: 'engine.link',
        linked: true,
        read: read('current', [grant()]),
        usage: { engines: 0, people: 2 },
        now,
        mode,
        ...input,
    });
}

describe('checkLicense', () => {
    it('lets one more engine or person through while the licence covers it', () => {
        for (const mode of ['advisory', 'enforce'] as const) {
            expect(check(mode)).toEqual({ outcome: 'ok' });
            expect(check(mode, { point: 'member.invite', usage: ONE_ENGINE })).toEqual({ outcome: 'ok' });
        }
    });

    it('only warns in advisory mode, whatever the shortfall', () => {
        expect(check('advisory', { usage: ONE_ENGINE })).toEqual({ outcome: 'warn', reason: 'over-limit' });
        expect(check('advisory', { linked: false, read: { kind: 'unknown' } })).toEqual({
            outcome: 'warn',
            reason: 'unlinked',
        });
        expect(check('advisory', { read: read('current', []) })).toEqual({ outcome: 'warn', reason: 'missing' });
        expect(check('advisory', { read: read('current', [grant(new Date(now - DAY).toISOString())]) })).toEqual({
            outcome: 'warn',
            reason: 'expired',
        });
    });

    it('denies in enforce mode on what the website just said, or without a linked account', () => {
        expect(check('enforce', { usage: ONE_ENGINE })).toEqual({ outcome: 'deny', reason: 'over-limit' });
        expect(check('enforce', { read: read('current', []) })).toEqual({ outcome: 'deny', reason: 'missing' });
        expect(check('enforce', { linked: false, read: { kind: 'unknown' } })).toEqual({
            outcome: 'deny',
            reason: 'unlinked',
        });
    });

    it('never denies on a stale answer, and says nothing while the website has not answered at all', () => {
        expect(check('enforce', { read: read('stale', []) })).toEqual({ outcome: 'warn', reason: 'missing' });
        expect(check('enforce', { read: { kind: 'unknown' } })).toEqual({ outcome: 'ok' });
        expect(check('advisory', { read: { kind: 'unknown' } })).toEqual({ outcome: 'ok' });
    });

    it('counts the people an invitation adds against each engine’s allowance', () => {
        const invite = { point: 'member.invite', usage: ONE_ENGINE } as const;
        expect(check('enforce', { ...invite, adding: 1 })).toEqual({ outcome: 'ok' });
        expect(check('enforce', { ...invite, adding: 2 })).toEqual({ outcome: 'deny', reason: 'over-limit' });
        expect(check('enforce', { ...invite, adding: 2, read: read('current', [grant(null, null)]) })).toEqual({
            outcome: 'deny',
            reason: 'over-limit',
        });
    });

    it('lets an unlimited licence take any number of engines', () => {
        expect(
            check('enforce', { usage: { engines: 50, people: 1 }, read: read('current', [grant(null, null)]) }),
        ).toEqual({ outcome: 'ok' });
    });
});
