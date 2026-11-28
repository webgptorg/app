import { describe, expect, it } from 'vitest';

import type { EmailMessage, NotificationEmailItem } from '../../domain/ports/email-sender';
import { NOTIFICATION_KINDS, NOTIFICATION_KIND_IDS } from '../../shared/notifications/registry';
import { renderEmail } from './render-email';

const AT = Date.UTC(2026, 9, 19, 14, 30);
const HOST = 'abcdefghijklmnopqrstuvwxyz.engines.ptbk.test';

function message(items: readonly NotificationEmailItem[], locale: 'en' | 'cs' = 'en') {
    return {
        template: 'notifications',
        to: 'ada@example.test',
        locale,
        place: { orgName: 'Acme', project: { label: 'Marketing site', hostname: HOST } },
        items,
        requesters: ['jana@example.test'],
        settingsLink: 'https://app.ptbk.test/account#notifications',
        unsubscribe: {
            page: 'https://app.ptbk.test/unsubscribe#tok',
            oneClick: 'https://app.ptbk.test/email/unsubscribe?token=tok',
        },
    } satisfies EmailMessage;
}

function item(kind: NotificationEmailItem['kind'], variant: string | null, count = 1): NotificationEmailItem {
    return { kind, variant, count, openedAt: AT, updatedAt: AT + 2 * 3600_000, link: `https://${HOST}/` };
}

/** Every kind with every variant (and none, for kinds without), in both locales. */
const CASES = NOTIFICATION_KIND_IDS.flatMap((kind) => {
    const variants: readonly (string | null)[] = NOTIFICATION_KINDS[kind].variants;
    return (variants.length === 0 ? [null] : variants).flatMap((variant) =>
        (['en', 'cs'] as const).flatMap((locale) => [1, 3].map((count) => ({ kind, variant, locale, count }))),
    );
});

describe('renderEmail: notifications', () => {
    it.each(CASES)('renders $kind ($variant, $count) in $locale with its link and the footer', (c) => {
        const { subject, text, headers } = renderEmail(message([item(c.kind, c.variant, c.count)], c.locale));
        expect(subject.trim()).not.toBe('');
        expect(text).toContain(`https://${HOST}/`);
        expect(text).toContain('https://app.ptbk.test/account#notifications');
        expect(text).toContain('https://app.ptbk.test/unsubscribe#tok');
        expect(text).not.toMatch(/undefined|null|NaN|\{[a-zA-Z]+\}/);
        expect(headers).toEqual({
            'List-Unsubscribe': '<https://app.ptbk.test/email/unsubscribe?token=tok>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        });
    });

    it('takes the one item’s subject, and counts several', () => {
        expect(renderEmail(message([item('project-status', 'offline')])).subject).toBe(
            'Your project Marketing site is offline',
        );
        const merged = renderEmail(message([item('agent-waiting', null, 2), item('task-failed', null, 1)]));
        expect(merged.subject).toBe('3 things need you in Marketing site');
        expect(merged.text).toContain('2 agents are waiting for you in Marketing site');
        expect(merged.text).toContain('A task failed in Marketing site');
    });

    it('says when an outage began and how long it lasted, in UTC', () => {
        const { text } = renderEmail(message([item('project-status', 'back-online')]));
        const flat = text.replace(/\s/g, ' ');
        expect(flat).toContain('offline for 2 hours');
        expect(flat).toContain('October 19, 2026 at 2:30 PM UTC');
        expect(flat).toContain('October 19, 2026 at 4:30 PM UTC');
    });

    it('names the waiting people the dashboard sent, and says the mailbox is not read', () => {
        const { text } = renderEmail(message([item('join-request', null, 1)]));
        expect(text).toContain('Waiting: jana@example.test.');
        expect(text).toContain("This mailbox isn't read.");
    });

    it('renders only what the message holds: nothing an engine could have put in it reaches the email', () => {
        const sentinel = 'ENGINE-SENTINEL';
        // Fields no notification message has; if rendering ever read them, the sentinel would show.
        const smuggled = {
            ...message([{ ...item('agent-waiting', null, 2), title: sentinel, preview: sentinel } as never]),
            agentName: sentinel,
        } as unknown as EmailMessage;
        const { subject, text } = renderEmail(smuggled);
        expect(`${subject}\n${text}`).not.toContain(sentinel);
        // And the shape itself: an item is a closed kind, a variant, a count, times and a link we built.
        expect(Object.keys(item('agent-waiting', null)).sort()).toEqual(
            ['count', 'kind', 'link', 'openedAt', 'updatedAt', 'variant'].sort(),
        );
    });
});
