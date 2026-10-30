import type { RenderedEmail } from '../../adapters/email/cloudflare-email-sender';
import { ALERT_RUNBOOKS, alertRoute } from '../../domain/monitoring/alert-routes';
import type { EmailMessage } from '../../domain/ports/email-sender';
import { m } from '../../paraglide/messages';

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
        case 'engine-offline':
            return {
                subject: m.email_engine_offline_subject({ label: message.label }, options),
                text: m.email_engine_offline_body(
                    {
                        label: message.label,
                        engineId: message.engineId,
                        hostname: message.hostname,
                        lastSeenAt: formatUtc(message.lastSeenAt, message.locale),
                        link: message.link,
                    },
                    options,
                ),
            };
        case 'engine-online':
            return {
                subject: m.email_engine_online_subject({ label: message.label }, options),
                text: m.email_engine_online_body(
                    {
                        label: message.label,
                        engineId: message.engineId,
                        hostname: message.hostname,
                        link: message.link,
                    },
                    options,
                ),
            };
        case 'engine-back-online':
            return {
                subject: m.email_engine_back_online_subject({ label: message.label }, options),
                text: m.email_engine_back_online_body(
                    {
                        label: message.label,
                        engineId: message.engineId,
                        hostname: message.hostname,
                        lastSeenAt: formatUtc(message.lastSeenAt, message.locale),
                        backOnlineAt: formatUtc(message.backOnlineAt, message.locale),
                        duration: formatDuration(message.backOnlineAt - message.lastSeenAt, message.locale),
                        link: message.link,
                    },
                    options,
                ),
            };
        case 'team-invite': {
            const org = message.orgName ?? message.inviterEmail;
            return {
                subject: m.email_team_invite_subject({ org }, options),
                text: m.email_team_invite_body(
                    {
                        inviter: message.inviterEmail,
                        org,
                        teams:
                            message.teamNames.length === 0
                                ? m.email_team_invite_no_teams({}, options)
                                : new Intl.ListFormat(message.locale, { type: 'conjunction' }).format(
                                      message.teamNames,
                                  ),
                        expiresAt: formatUtc(message.expiresAt, message.locale),
                        link: message.link,
                    },
                    options,
                ),
            };
        }
        case 'access-waiting':
            return {
                subject: m.email_access_waiting_subject(
                    { requester: message.requesterEmail, team: message.teamName },
                    options,
                ),
                text: m.email_access_waiting_body(
                    { requester: message.requesterEmail, team: message.teamName, link: message.link },
                    options,
                ),
            };
        case 'access-granted':
            return {
                subject: m.email_access_granted_subject({ team: message.teamName }, options),
                text: m.email_access_granted_body({ team: message.teamName, link: message.link }, options),
            };
        case 'ops-alert':
            return renderOpsAlert(message);
    }
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
