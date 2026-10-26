import { describe, expect, it } from 'vitest';

import { securityTxt } from './security-txt';

describe('securityTxt', () => {
    const input = { abuseEmail: 'abuse@ptbk.test', dashboardOrigin: 'https://app.ptbk.test' };

    it('states the RFC 9116 fields, expiring 180 days after the current UTC day', () => {
        expect(securityTxt({ ...input, nowMs: Date.UTC(2026, 9, 23, 17, 30) })).toBe(
            [
                'Contact: mailto:abuse@ptbk.test',
                'Expires: 2027-04-21T00:00:00Z',
                'Policy: https://app.ptbk.test/abuse',
                'Preferred-Languages: en, cs',
                'Canonical: https://app.ptbk.test/.well-known/security.txt',
                '',
            ].join('\n'),
        );
    });

    it('stays the same for a whole day', () => {
        const morning = securityTxt({ ...input, nowMs: Date.UTC(2026, 9, 23) });
        expect(securityTxt({ ...input, nowMs: Date.UTC(2026, 9, 23, 23, 59, 59) })).toBe(morning);
        expect(securityTxt({ ...input, nowMs: Date.UTC(2026, 9, 24) })).not.toBe(morning);
    });
});
