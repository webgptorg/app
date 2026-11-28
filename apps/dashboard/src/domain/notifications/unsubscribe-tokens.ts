import type { NotificationKind } from '../../shared/notifications/registry';
import type { OrgId, UserId } from '../ids';

/** What an unsubscribe link may do: turn email off for these kinds, for this person in this organization. Nothing else. */
export interface UnsubscribeClaims {
    readonly userId: UserId;
    readonly orgId: OrgId;
    readonly kinds: readonly NotificationKind[];
}

/** Signs and verifies the single-purpose token of an email's unsubscribe links (ADR 0027). */
export interface UnsubscribeTokens {
    sign(claims: UnsubscribeClaims): Promise<string>;
    /** Null for anything not signed by us for this purpose, whatever is wrong with it. */
    verify(token: string): Promise<UnsubscribeClaims | null>;
}
