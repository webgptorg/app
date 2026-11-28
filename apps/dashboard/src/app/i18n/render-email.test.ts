import { describe, expect, it } from 'vitest';

import type { EmailMessage } from '../../domain/ports/email-sender';
import { renderEmail } from './render-email';

const RECOVERED_AT = Date.UTC(2026, 9, 19, 14, 30);
const MESSAGES: readonly Omit<EmailMessage, 'locale'>[] = [
    { template: 'signup-link', to: 'a@example.test', link: 'https://app.ptbk.test/signup#tok' },
    {
        template: 'account-exists',
        to: 'a@example.test',
        signInLink: 'https://app.ptbk.test/continue',
        recoveryLink: 'https://app.ptbk.test/recover',
    },
    { template: 'recovery-link', to: 'a@example.test', link: 'https://app.ptbk.test/recover#tok' },
    {
        template: 'recovery-notice',
        to: 'a@example.test',
        recoveredAt: RECOVERED_AT,
        cooldownEndsAt: RECOVERED_AT + 72 * 3600_000,
        signInLink: 'https://app.ptbk.test/continue',
    },
    {
        template: 'access-granted',
        to: 'jana@example.test',
        teamName: 'Kancelář Brno',
        hostname: 'abcdefghijklmnopqrstuvwxyz.engines.ptbk.test',
        link: 'https://abcdefghijklmnopqrstuvwxyz.engines.ptbk.test/',
    },
    {
        template: 'invite-passkey-link',
        to: 'a@example.test',
        orgName: null,
        link: 'https://app.ptbk.test/recover?via=invite#tok',
    },
] as EmailMessage[];
const GRANTED = MESSAGES[4] as Extract<EmailMessage, { template: 'access-granted' }>;

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

    const INVITE = {
        template: 'team-invite',
        to: 'eve@example.test',
        locale: 'en',
        inviterEmail: 'ada@example.test',
        orgName: null,
        teamNames: ['Northwind'],
        expiresAt: 1_800_000_000_000,
        link: 'https://app.ptbk.test/invites#token',
    } as unknown as EmailMessage;

    it.each(['en', 'cs'] as const)(
        'invites to the inviter’s unnamed organization, not to the inviter (%s)',
        (locale) => {
            const { subject, text } = renderEmail({ ...INVITE, locale });
            expect(subject).toContain('ada@example.test');
            expect(text.match(/ada@example\.test/g)).toHaveLength(1);
            expect(text).toContain('Northwind');
            expect(text).not.toMatch(/undefined|\{[a-zA-Z]+\}/);
        },
    );

    it('names an organization that has a name', () => {
        const { subject, text } = renderEmail({ ...INVITE, orgName: 'Acme' } as EmailMessage);
        expect(subject).toBe("You're invited to Acme on Promptbook");
        expect(text).toContain('ada@example.test invited you to Acme on Promptbook.');
    });

    it.each([
        ['en', 'Add a passkey to join Acme', 'and you can join Acme.'],
        ['cs', 'Přidejte si přístupový klíč a připojte se k Acme', 'můžete připojit k Acme.'],
    ] as const)(
        'words the invitee’s recovery link for joining and still names both effects in %s',
        (locale, subject, joins) => {
            const { subject: rendered, text } = renderEmail({
                template: 'invite-passkey-link',
                to: 'a@example.test',
                locale,
                orgName: 'Acme',
                link: 'https://app.ptbk.test/recover?via=invite#tok',
            });
            expect(rendered).toBe(subject);
            expect(text).toContain(joins);
            expect(text).toContain('72');
            expect(text).toMatch(locale === 'en' ? /signs out your other devices/ : /odhlásí Vaše ostatní zařízení/);
            expect(text.replace('https://app.ptbk.test/recover', '')).not.toMatch(/recover|obnov/i);
        },
    );

    it('differs between English and Czech', () => {
        const en = renderEmail({ ...MESSAGES[0], locale: 'en' } as EmailMessage);
        const cs = renderEmail({ ...MESSAGES[0], locale: 'cs' } as EmailMessage);
        expect(en.subject).not.toBe(cs.subject);
    });

    it.each(
        MESSAGES.flatMap((message) =>
            (['en', 'cs'] as const).map((locale) => ({ ...message, locale }) as EmailMessage),
        ),
    )(
        'greets on its own line and starts the first sentence as its locale writes it: $template in $locale',
        (message) => {
            const { text } = renderEmail(message);
            // Czech letters continue in lower case after the comma of the greeting; English starts a new sentence.
            expect(text).toMatch(message.locale === 'en' ? /^Hi,\n\n[A-Z]/ : /^Dobrý den,\n\n\p{Ll}/u);
        },
    );

    it.each([
        ['en', 'October 19, 2026 at 2:30 PM UTC', 'October 22, 2026 at 2:30 PM UTC'],
        ['cs', '19. října 2026 v 14:30 UTC', '22. října 2026 v 14:30 UTC'],
    ] as const)('names the zone of the recovery time and the end of the cooldown in %s', (locale, recovered, until) => {
        const { text: raw } = renderEmail({ ...MESSAGES[3], locale } as EmailMessage);
        const text = raw.replace(/\s/g, ' ');
        expect(text).toContain(recovered);
        expect(text).toContain(until);
        expect(text).not.toContain('(UTC)');
    });

    it('tells the person they are in, with the engine’s own address', () => {
        expect(renderEmail({ ...GRANTED, locale: 'en' }).subject).toBe("You're in: open Kancelář Brno");
        expect(renderEmail({ ...GRANTED, locale: 'cs' }).subject).toBe('Máte přístup: otevřete Kancelář Brno');
        const { text } = renderEmail({ ...GRANTED, locale: 'en' });
        expect(text).toContain('https://abcdefghijklmnopqrstuvwxyz.engines.ptbk.test/');
        expect(text).toContain('abcdefghijklmnopqrstuvwxyz.engines.ptbk.test,');
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
