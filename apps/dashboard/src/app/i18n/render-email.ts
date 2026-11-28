import type { RenderedEmail } from '../../adapters/email/cloudflare-email-sender';
import { ALERT_RUNBOOKS, alertRoute } from '../../domain/monitoring/alert-routes';
import type { EmailMessage } from '../../domain/ports/email-sender';
import { m } from '../../paraglide/messages';
import { anyKind } from '../../shared/notifications/registry';

/**
 * "October 19, 2026 at 2:30 PM UTC": the dashboard knows no recipient's time zone, so every time is UTC and says so in
 * the recipient's own words. `dateStyle` cannot be combined with `timeZoneName`, hence the separate fields.
 */
function formatUtc(ms: number, locale: EmailMessage['locale']): string {
    return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'UTC',
        timeZoneName: 'short',
    }).format(ms);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "2 days, 3 hours" or "5 minutes": the two largest units, rounded down, zeros left out, and at least a minute. */
function formatDuration(ms: number, locale: EmailMessage['locale']): string {
    const days = Math.floor(ms / DAY_MS);
    const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    const largest: readonly (readonly [number, 'day' | 'hour' | 'minute'])[] =
        days > 0
            ? [
                  [days, 'day'],
                  [hours, 'hour'],
              ]
            : [
                  [hours, 'hour'],
                  [minutes, 'minute'],
              ];
    const nonZero = largest.filter(([value]) => value > 0);
    const parts = (nonZero.length === 0 ? [[1, 'minute'] as const] : nonZero).map(([value, unit]) =>
        new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value),
    );
    return new Intl.ListFormat(locale, { style: 'long', type: 'unit' }).format(parts);
}

/** Plain text only: no HTML means nothing in an email can be markup, and links stay visible for what they are. */
export function renderEmail(message: EmailMessage): RenderedEmail {
    const options = { locale: message.locale };
    switch (message.template) {
        case 'signup-link':
            return {
                subject: m.email_signup_link_subject({}, options),
                text: m.email_signup_link_body({ link: message.link }, options),
            };
        case 'account-exists':
            return {
                subject: m.email_account_exists_subject({}, options),
                text: m.email_account_exists_body(
                    { signInLink: message.signInLink, recoveryLink: message.recoveryLink },
                    options,
                ),
            };
        case 'recovery-link':
            return {
                subject: m.email_recovery_link_subject({}, options),
                text: m.email_recovery_link_body({ link: message.link }, options),
            };
        case 'invite-passkey-link': {
            const org = message.orgName;
            return org === null
                ? {
                      subject: m.email_invite_passkey_subject_unnamed({}, options),
                      text: m.email_invite_passkey_body_unnamed({ link: message.link }, options),
                  }
                : {
                      subject: m.email_invite_passkey_subject({ org }, options),
                      text: m.email_invite_passkey_body({ org, link: message.link }, options),
                  };
        }
        case 'recovery-notice':
            return {
                subject: m.email_recovery_notice_subject({}, options),
                text: m.email_recovery_notice_body(
                    {
                        recoveredAt: formatUtc(message.recoveredAt, message.locale),
                        cooldownEndsAt: formatUtc(message.cooldownEndsAt, message.locale),
                        signInLink: message.signInLink,
                    },
                    options,
                ),
            };
        case 'notifications':
            return renderNotifications(message);
        case 'team-invite': {
            const body = {
                inviter: message.inviterEmail,
                teams:
                    message.teamNames.length === 0
                        ? m.email_team_invite_no_teams({}, options)
                        : new Intl.ListFormat(message.locale, { type: 'conjunction' }).format(message.teamNames),
                expiresAt: formatUtc(message.expiresAt, message.locale),
                link: message.link,
            };
            const org = message.orgName;
            return org === null
                ? {
                      subject: m.email_team_invite_subject_unnamed({ inviter: message.inviterEmail }, options),
                      text: m.email_team_invite_body_unnamed(body, options),
                  }
                : {
                      subject: m.email_team_invite_subject({ org }, options),
                      text: m.email_team_invite_body({ ...body, org }, options),
                  };
        }
        case 'access-granted':
            return {
                subject: m.email_access_granted_subject({ engine: message.teamName }, options),
                text: m.email_access_granted_body(
                    { engine: message.teamName, hostname: message.hostname, link: message.link },
                    options,
                ),
            };
        case 'ops-alert':
            return renderOpsAlert(message);
    }
}

/**
 * Each kind's own copy, in the order the rows came due; one item takes its kind's subject, several are counted. Every
 * value comes from the dashboard: nothing an engine sent is rendered, only the counts it reported.
 */
function renderNotifications(message: Extract<EmailMessage, { readonly template: 'notifications' }>): RenderedEmail {
    const { locale, place } = message;
    const context = {
        locale,
        time: (ms: number) => formatUtc(ms, locale),
        duration: (ms: number) => formatDuration(ms, locale),
    };
    const extras = { requesters: message.requesters };
    const sections = message.items.map((item) => {
        const { copy } = anyKind(item.kind);
        const detail = copy.detail?.(item, place, context, extras) ?? null;
        return [
            copy.line(item, place, context),
            ...(detail === null ? [] : [detail]),
            m.notification_email_open({ link: item.link }, { locale }),
        ].join('\n\n');
    });
    const [only] = message.items;
    const subject =
        only !== undefined && message.items.length === 1
            ? anyKind(only.kind).copy.subject(only, place, context)
            : m.notification_things_line(
                  {
                      count: message.items.reduce((sum, item) => sum + item.count, 0),
                      place: place.project?.label ?? place.orgName ?? m.notification_org_unnamed({}, { locale }),
                  },
                  { locale },
              );
    return {
        subject,
        text: [
            ...sections,
            m.notification_email_footer(
                { settings: message.settingsLink, unsubscribe: message.unsubscribe.page },
                { locale },
            ),
        ].join('\n\n'),
        // RFC 8058: providers post `List-Unsubscribe=One-Click` to the HTTPS URL, which turns these kinds' email off.
        headers: {
            'List-Unsubscribe': `<${message.unsubscribe.oneClick}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
    };
}

/** Ops alerts go to the team only, in English, so they are not part of the translated catalogue. */
function renderOpsAlert(message: Extract<EmailMessage, { readonly template: 'ops-alert' }>): RenderedEmail {
    const state = message.state === 'firing' ? 'FIRING' : 'resolved';
    const route = alertRoute(message.rule);
    const detail = Object.entries(message.detail).map(([name, value]) => `${name}: ${String(value)}`);
    return {
        subject: `[ptbk ${route}] ${state}: ${message.rule} (${message.subject})`,
        text: [
            `${message.rule} is ${state} for ${message.subject} since ${new Date(message.at).toISOString()}.`,
            ...detail,
            '',
            `Runbook: ${ALERT_RUNBOOKS[route]}`,
        ].join('\n'),
    };
}
