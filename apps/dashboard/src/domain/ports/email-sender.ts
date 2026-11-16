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
      })
    | (Envelope & {
          readonly template: 'engine-offline';
          /** `engineLabel()`: the owner's label, or the short engine ID. */
          readonly label: string;
          readonly engineId: string;
          readonly hostname: string;
          readonly lastSeenAt: number;
          /** The engine's page in the dashboard. Nothing else is known about the engine, so nothing else is sent. */
          readonly link: string;
      })
    | (Envelope & {
          /** Never the setup link: only the engine can make someone its owner, so only its terminal shows that link. */
          readonly template: 'engine-online';
          readonly label: string;
          readonly engineId: string;
          readonly hostname: string;
          readonly link: string;
      })
    | (Envelope & {
          readonly template: 'engine-back-online';
          readonly label: string;
          readonly engineId: string;
          readonly hostname: string;
          /** The last heartbeat before the outage. */
          readonly lastSeenAt: number;
          /** The first heartbeat after it. */
          readonly backOnlineAt: number;
          readonly link: string;
      })
    | (Envelope & {
          /** An invitation to an organization and its teams (ADR 0018); names typed by the inviting organization. */
          readonly template: 'team-invite';
          readonly inviterEmail: string;
          /** Null for an organization without a name, e.g. a personal one: the email then names the inviter. */
          readonly orgName: string | null;
          readonly teamNames: readonly string[];
          readonly expiresAt: number;
          readonly link: string;
      })
    | (Envelope & {
          /**
           * Someone opened an engine of the organization and waits for approval there. Names, the engine's hostname and
           * a link to it only: never a secret, never anything from inside the engine.
           */
          readonly template: 'access-waiting';
          readonly requesterEmail: string;
          /** The team's name, which the screens call the engine's. */
          readonly teamName: string;
          /** `https://<engine hostname>/members`, where the engine lists its access requests. */
          readonly link: string;
      })
    | (Envelope & {
          /** The team's engine approved the recipient's access request. */
          readonly template: 'access-granted';
          readonly teamName: string;
          readonly hostname: string;
          /** `https://<hostname>/`: the engine itself. */
          readonly link: string;
      })
    | (Envelope & {
          /**
           * I-04: to the ops address, numbers and names of our own relays and jobs; I-05's abuse rules go to the abuse
           * inbox with an engine ID or a certificate's issuance key as the subject. Never engine content.
           */
          readonly template: 'ops-alert';
          readonly rule: string;
          readonly subject: string;
          readonly state: 'firing' | 'resolved';
          readonly at: number;
          readonly detail: Readonly<Record<string, number>>;
      });

export type EmailTemplate = EmailMessage['template'];

export interface EmailSender {
    /** Resolves once the provider accepted the message; rejects on failure or when `signal` aborts. */
    send(message: EmailMessage, signal: AbortSignal): Promise<void>;
}
