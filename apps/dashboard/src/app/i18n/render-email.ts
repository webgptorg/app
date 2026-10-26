import type { RenderedEmail } from '../../adapters/email/cloudflare-email-sender';
import { ALERT_RUNBOOKS, alertRoute } from '../../domain/monitoring/alert-routes';
import type { EmailMessage } from '../../domain/ports/email-sender';
import { m } from '../../paraglide/messages';

function formatUtc(ms: number, locale: EmailMessage['locale']): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(ms);
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
                subject: m.email_engine_offline_subject({ hostname: message.hostname }, options),
                text: m.email_engine_offline_body(
                    {
                        engineId: message.engineId,
                        hostname: message.hostname,
                        lastSeenAt: formatUtc(message.lastSeenAt, message.locale),
                        link: message.link,
                    },
                    options,
                ),
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
