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
    {
        template: 'engine-online',
        to: 'a@example.test',
        engineId: 'abcdefghijklmnopqrstuvwxyz',
        hostname: 'abcdefghijklmnopqrstuvwxyz.engines.ptbk.test',
        link: 'https://app.ptbk.test/engines/abcdefghijklmnopqrstuvwxyz',
    },
    {
        template: 'engine-back-online',
        to: 'a@example.test',
        engineId: 'abcdefghijklmnopqrstuvwxyz',
        hostname: 'abcdefghijklmnopqrstuvwxyz.engines.ptbk.test',
        lastSeenAt: RECOVERED_AT,
        backOnlineAt: RECOVERED_AT + (2 * 24 + 3) * 3600_000 + 59 * 60_000,
        link: 'https://app.ptbk.test/engines/abcdefghijklmnopqrstuvwxyz',
    },
] as EmailMessage[];
const ONLINE = MESSAGES[5] as Extract<EmailMessage, { template: 'engine-online' }>;
const BACK_ONLINE = MESSAGES[6] as Extract<EmailMessage, { template: 'engine-back-online' }>;

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

    it.each([
        ['en', 'Your engine abcdefghijklmnopqrstuvwxyz.engines.ptbk.test is online', 'only the engine can make you'],
        ['cs', 'Váš engine abcdefghijklmnopqrstuvwxyz.engines.ptbk.test je online', 'jen engine sám'],
    ] as const)(
        'sends the first-online email in %s pointing to the terminal, never with a setup link',
        (locale, subject, why) => {
            const { subject: rendered, text } = renderEmail({ ...ONLINE, locale });
            expect(rendered).toBe(subject);
            expect(text).toContain(why);
            expect(text).toContain('abcdefghijklmnopqrstuvwxyz\n');
            expect(text.match(/https:\/\/\S+/g)).toEqual([ONLINE.link]);
        },
    );

    it.each([
        ['en', 'is back online', 'October 19, 2026 at 2:30', 'October 21, 2026 at 6:29', '2 days, 3 hours'],
        ['cs', 'je zase online', '19. října 2026 v 14:30', '21. října 2026 v 18:29', '2 dny a 3 hodiny'],
    ] as const)(
        'says in %s since when the engine is back and how long it was offline',
        (locale, subject, from, back, duration) => {
            const { subject: rendered, text: raw } = renderEmail({ ...BACK_ONLINE, locale });
            // ICU puts no-break spaces into some units and times.
            const text = raw.replace(/\s/g, ' ');
            expect(rendered).toContain(subject);
            expect(rendered).toContain(BACK_ONLINE.hostname);
            expect(text).toContain(from);
            expect(text).toContain(back);
            expect(text).toContain(duration);
        },
    );

    it.each([
        [3 * 60_000, '3 minutes'],
        [30_000, '1 minute'],
        [3600_000, '1 hour'],
        [(5 * 60 + 7) * 60_000, '5 hours, 7 minutes'],
        [2 * 24 * 3600_000 + 59 * 60_000, '2 days'],
    ])('rounds an outage of %i ms down to "%s"', (offlineMs, duration) => {
        const { text } = renderEmail({ ...BACK_ONLINE, locale: 'en', backOnlineAt: RECOVERED_AT + offlineMs });
        expect(text.replace(/\s/g, ' ')).toContain(`offline for ${duration}.`);
    });

    it('renders an ops alert in English with its rule, subject, time and numbers only', () => {
        const message: EmailMessage = {
            template: 'ops-alert',
            to: 'ops@ptbk.test',
            locale: 'en',
            rule: 'relay-unreachable',
            subject: 'relay-a',
            state: 'firing',
            at: RECOVERED_AT,
            detail: { failedChecks: 2 },
        };
        expect(renderEmail(message)).toEqual({
            subject: '[ptbk ops] FIRING: relay-unreachable (relay-a)',
            text: [
                'relay-unreachable is FIRING for relay-a since 2026-10-19T14:30:00.000Z.',
                'failedChecks: 2',
                '',
                'Runbook: docs/runbooks/observability.md',
            ].join('\n'),
        });
        expect(renderEmail({ ...message, state: 'resolved', detail: {} }).subject).toBe(
            '[ptbk ops] resolved: relay-unreachable (relay-a)',
        );
        const abuse = renderEmail({ ...message, rule: 'ct-wildcard', subject: 'a'.repeat(64), detail: {} });
        expect(abuse.subject).toBe(`[ptbk abuse] FIRING: ct-wildcard (${'a'.repeat(64)})`);
        expect(abuse.text).toContain('Runbook: docs/runbooks/abuse-takedown.md');
    });
});
