import type { AlertSink } from '../../domain/monitoring/alert-sink';
import type { EmailSender } from '../../domain/ports/email-sender';

/** Alerts as plain-text emails to the ops address, through the dashboard's own email binding. */
export function createEmailAlertSink(deps: { readonly email: EmailSender; readonly to: string }): AlertSink {
    return {
        send(alert, signal) {
            return deps.email.send(
                {
                    template: 'ops-alert',
                    to: deps.to,
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
