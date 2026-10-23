import type { DashboardMetrics } from '../../domain/monitoring/dashboard-metrics';
import type { EmailSender } from '../../domain/ports/email-sender';

/** Counts every email by template and outcome (I-04), whichever adapter sends it. */
export function createMeteredEmailSender(inner: EmailSender, metrics: DashboardMetrics): EmailSender {
    return {
        async send(message, signal) {
            try {
                await inner.send(message, signal);
            } catch (error) {
                metrics.record({ name: 'ptbk_dashboard_emails_total', template: message.template, outcome: 'failed' });
                throw error;
            }
            metrics.record({ name: 'ptbk_dashboard_emails_total', template: message.template, outcome: 'sent' });
        },
    };
}
