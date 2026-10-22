import { describe, expect, it } from 'vitest';

import { emailedLink, isEngineUrl, parseRegisterReport, uniqueEmail } from './dashboard-outputs.ts';

const TOKEN = 'A'.repeat(43);

describe('emailedLink', () => {
    it('takes the newest link of the template', () => {
        const outbox = JSON.stringify({
            emails: [
                { template: 'signup-link', text: `Open https://app.ptbk.test/signup#${'B'.repeat(43)} now.` },
                { template: 'account-exists', text: 'You already have an account.' },
                { template: 'signup-link', text: `Open https://app.ptbk.test/signup#${TOKEN} now.` },
            ],
        });
        expect(emailedLink(outbox, 'signup-link')).toBe(`https://app.ptbk.test/signup#${TOKEN}`);
        expect(emailedLink(outbox, 'recovery-link')).toBeUndefined();
    });

    it('refuses an answer without an email list', () => {
        expect(() => emailedLink('{}', 'signup-link')).toThrow('unexpected outbox answer');
    });
});

describe('parseRegisterReport', () => {
    it("reads the register command's last line", () => {
        expect(parseRegisterReport('{"outcome":"rejected","reason":"invalid-link-code"}\n')).toEqual({
            outcome: 'rejected',
            reason: 'invalid-link-code',
        });
    });

    it('refuses output without a report', () => {
        expect(() => parseRegisterReport('{}\n')).toThrow('no report');
        expect(() => parseRegisterReport('')).toThrow(SyntaxError);
    });
});

describe('isEngineUrl', () => {
    it('matches the engine domain and every name under it, nothing else', () => {
        expect(isEngineUrl('https://abc.engine.test/')).toBe(true);
        expect(isEngineUrl('wss://engine.test/x')).toBe(true);
        expect(isEngineUrl('https://app.ptbk.test/api/engines')).toBe(false);
        expect(isEngineUrl('https://notengine.test/')).toBe(false);
        expect(isEngineUrl('data:,')).toBe(false);
    });
});

describe('uniqueEmail', () => {
    it('never repeats', () => {
        expect(uniqueEmail('a')).not.toBe(uniqueEmail('a'));
    });
});
