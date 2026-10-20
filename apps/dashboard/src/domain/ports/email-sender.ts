import type { Locale } from '../locale';

interface Envelope {
    readonly to: string;
    readonly locale: Locale;
}

/** Every email the dashboard sends, as typed template data; adapters render it in the recipient's locale. */
export type EmailMessage =
    | (Envelope & { readonly template: 'signup-link'; readonly link: string })
    | (Envelope & { readonly template: 'account-exists'; readonly signInLink: string; readonly recoveryLink: string })
    | (Envelope & { readonly template: 'recovery-link'; readonly link: string })
    | (Envelope & {
          readonly template: 'recovery-notice';
          /** Milliseconds since the Unix epoch. */
          readonly recoveredAt: number;
          readonly cooldownEndsAt: number;
          readonly signInLink: string;
      });

export type EmailTemplate = EmailMessage['template'];

export interface EmailSender {
    /** Resolves once the provider accepted the message; rejects on failure or when `signal` aborts. */
    send(message: EmailMessage, signal: AbortSignal): Promise<void>;
}
