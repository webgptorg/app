import { describe, expect, it } from 'vitest';

import type { EmailMessage } from '../../domain/ports/email-sender';
import { renderEmail } from './render-email';

const RECOVERED_AT = Date.UTC(2026, 9, 19, 14, 30);
const MESSAGES: readonly Omit<EmailMessage, 'locale'>[] = [
    { template: 'signup-link', to: 'a@example.test', link: 'https://app.ptbk.test/signup#tok' },
    {
        template: 'account-exists',
        to: 'a@example.test',
        signInLink: 'https://app.ptbk.test/signin',
        recoveryLink: 'https://app.ptbk.test/recover',
    },
    { template: 'recovery-link', to: 'a@example.test', link: 'https://app.ptbk.test/recover#tok' },
    {
        template: 'recovery-notice',
        to: 'a@example.test',
        recoveredAt: RECOVERED_AT,
        cooldownEndsAt: RECOVERED_AT + 72 * 3600_000,
        signInLink: 'https://app.ptbk.test/signin',
    },
    {
        template: 'engine-offline',
        to: 'a@example.test',
        engineId: 'abcdefghijklmnopqrstuvwxyz',
        hostname: 'abcdefghijklmnopqrstuvwxyz.engines.ptbk.test',
        lastSeenAt: RECOVERED_AT,
        link: 'https://app.ptbk.test/engines/abcdefghijklmnopqrstuvwxyz',
    },
] as EmailMessage[];

describe('renderEmail', () => {
    it.each(
        MESSAGES.flatMap((message) =>
            (['en', 'cs'] as const).map((locale) => ({ ...message, locale }) as EmailMessage),
        ),
    )('renders $template in $locale with every link', (message) => {
        const { subject, text } = renderEmail(message);
        expect(subject.trim()).not.toBe('');
        for (const value of Object.values(message)) {
            if (typeof value === 'string' && value.startsWith('https://')) {
                expect(text).toContain(value);
            }
        }
        expect(text).not.toMatch(/undefined|\{[a-zA-Z]+\}/);
    });

    it('differs between English and Czech', () => {
        const en = renderEmail({ ...MESSAGES[0], locale: 'en' } as EmailMessage);
        const cs = renderEmail({ ...MESSAGES[0], locale: 'cs' } as EmailMessage);
        expect(en.subject).not.toBe(cs.subject);
    });

    it('states the recovery time and the end of the cooldown in UTC', () => {
        const { text } = renderEmail({ ...MESSAGES[3], locale: 'en' } as EmailMessage);
        expect(text).toContain('October 19, 2026 at 2:30');
        expect(text).toContain('October 22, 2026 at 2:30');
    });

    it.each(['en', 'cs'] as const)('names the engine, its hostname and when it was last seen in %s', (locale) => {
        const { subject, text } = renderEmail({ ...MESSAGES[4], locale } as EmailMessage);
        expect(subject).toContain('abcdefghijklmnopqrstuvwxyz.engines.ptbk.test');
        expect(text).toContain('abcdefghijklmnopqrstuvwxyz.engines.ptbk.test');
        expect(text).toContain('abcdefghijklmnopqrstuvwxyz\n');
        expect(text).toContain(locale === 'en' ? 'October 19, 2026 at 2:30' : '19. října 2026 v 14:30');
    });
});
