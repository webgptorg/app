import type { NotificationItem, NotificationPlace } from '../../shared/notifications/notification-kind';
import type { NotificationKind } from '../../shared/notifications/registry';
import type { Locale } from '../locale';

/** One kind's line in a notification email, with where its link goes. */
export interface NotificationEmailItem extends NotificationItem {
    readonly kind: NotificationKind;
    readonly link: string;
}

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
          /** The recovery link, worded for an invitee adding a passkey (D-35); same token, same effects. */
          readonly template: 'invite-passkey-link';
          /** From a pending invitation to the recipient, never from the request; null for an unnamed organization. */
          readonly orgName: string | null;
          readonly link: string;
      })
    | (Envelope & {
          readonly template: 'recovery-notice';
          /** Milliseconds since the Unix epoch. */
          readonly recoveredAt: number;
          readonly cooldownEndsAt: number;
          readonly signInLink: string;
      })
    | (Envelope & {
          /**
           * D-41: everything due for one person about one project (or organization), merged (ADR 0027). Only what the
           * dashboard owns: the organization's name, the project's label and hostname, kinds, counts and times.
           */
          readonly template: 'notifications';
          readonly place: NotificationPlace;
          readonly items: readonly NotificationEmailItem[];
          /** `join-request` only: addresses of the people the dashboard sent to the project who still wait. */
          readonly requesters: readonly string[];
          readonly settingsLink: string;
          readonly unsubscribe: {
              /** The SPA page that asks before it turns anything off, for the link in the body. */
              readonly page: string;
              /** RFC 8058's one-click POST target, for `List-Unsubscribe`. */
              readonly oneClick: string;
          };
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
