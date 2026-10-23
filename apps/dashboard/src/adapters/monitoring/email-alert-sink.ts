import { alertRoute, type AlertRoute } from '../../domain/monitoring/alert-routes';
import type { AlertSink } from '../../domain/monitoring/alert-sink';
import type { EmailSender } from '../../domain/ports/email-sender';

/**
 * Alerts as plain-text emails through the dashboard's own email binding: to the ops address, or for the abuse rules
 * (I-05) to the abuse inbox.
 */
export function createEmailAlertSink(deps: {
    readonly email: EmailSender;
    readonly recipients: Readonly<Record<AlertRoute, string>>;
}): AlertSink {
    return {
        send(alert, signal) {
            return deps.email.send(
                {
                    template: 'ops-alert',
                    to: deps.recipients[alertRoute(alert.rule)],
                    // Ops mail is for the team, in one language.
                    locale: 'en',
                    rule: alert.rule,
                    subject: alert.subject,
                    state: alert.state,
                    at: alert.at,
                    detail: alert.detail,
                },
                signal,
            );
        },
    };
}
