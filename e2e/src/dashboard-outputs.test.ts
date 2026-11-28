import { describe, expect, it } from 'vitest';

import {
    devInstallLinkCode,
    distinctInOrder,
    emailedLink,
    isEngineUrl,
    outboxEmails,
    parseRegisterReport,
    parseSetupLink,
    terminalIdentity,
    uniqueEmail,
} from './dashboard-outputs.ts';

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

describe('outboxEmails', () => {
    it('lists every email with the fields the tests read, oldest first', () => {
        const email = { template: 'notifications', to: 'a@example.test', locale: 'en', subject: 'S', text: 'T' };
        expect(outboxEmails(JSON.stringify({ emails: [email, { ...email, subject: 'S2' }] }))).toEqual([
            { template: 'notifications', to: 'a@example.test', subject: 'S', text: 'T' },
            { template: 'notifications', to: 'a@example.test', subject: 'S2', text: 'T' },
        ]);
    });

    it('refuses an answer without an email list or an email without its fields', () => {
        expect(() => outboxEmails('{}')).toThrow('unexpected outbox answer');
        expect(() => outboxEmails(JSON.stringify({ emails: [{ template: 'x', to: 'a', text: 'T' }] }))).toThrow(
            'unexpected outbox email',
        );
        expect(() => outboxEmails(JSON.stringify({ emails: [null] }))).toThrow('unexpected outbox email');
    });
});

describe('devInstallLinkCode', () => {
    it('reads the code from the dev install command and nothing else', () => {
        const code = 'a'.repeat(26);
        expect(devInstallLinkCode(`bun run dev:link ${code}\n`)).toBe(code);
        expect(() => devInstallLinkCode(`sudo sh promptbook-install.sh --link ${code}`)).toThrow('no dev install');
        expect(() => devInstallLinkCode('bun run dev:link ABC')).toThrow('no dev install');
    });
});

describe('terminalIdentity', () => {
    it("reads connect's identity lines", () => {
        const stdout = [
            '✓ Engine key ready',
            '        Engine ID     abc',
            '        Address       https://abc.engine.test',
            '        Fingerprint   K7QD-2MXA-PL3F   (the dashboard shows the same)',
            '✓ Linked to your Promptbook account',
        ].join('\n');
        expect(terminalIdentity(stdout)).toEqual({
            engineId: 'abc',
            hostname: 'abc.engine.test',
            fingerprint: 'K7QD-2MXA-PL3F',
        });
        expect(() => terminalIdentity('✗ The link code was not accepted.')).toThrow('no identity');
    });
});

describe('parseSetupLink', () => {
    it('reads the link and its secret from the last line', () => {
        const url = `https://abc.engine.test/setup#${TOKEN}`;
        const stdout = `${JSON.stringify({ outcome: 'created', url, expiresAt: '2026-10-27T10:00:00Z' })}\n`;
        expect(parseSetupLink(stdout)).toEqual({ url, secret: TOKEN });
    });

    it('refuses an answer without a link or a link without a secret', () => {
        expect(() => parseSetupLink('{"outcome":"owner-exists"}')).toThrow('no setup link: owner-exists');
        expect(() => parseSetupLink('{"outcome":"created","url":"https://abc.engine.test/setup"}')).toThrow(
            'no secret',
        );
    });
});

describe('distinctInOrder', () => {
    it('drops consecutive repeats only', () => {
        expect(distinctInOrder(['waiting', 'waiting', 'linked', 'ready', 'linked'])).toEqual([
            'waiting',
            'linked',
            'ready',
            'linked',
        ]);
        expect(distinctInOrder([])).toEqual([]);
    });
});
