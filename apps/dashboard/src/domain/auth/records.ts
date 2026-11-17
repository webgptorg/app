import type { AuthenticatorTransport } from '../../shared/api/webauthn';
import type { OrgId, UserId } from '../ids';
import type { Locale } from '../locale';
import type { OrgRole, PlatformRole } from '../roles';

// Timestamps are milliseconds since the Unix epoch. Secrets appear only as SHA-256 hex digests (`*Hash`).

export interface UserRecord {
    readonly id: UserId;
    readonly email: string;
    readonly emailVerifiedAt: number | null;
    readonly locale: Locale;
    readonly platformRole: PlatformRole;
    readonly recoveredAt: number | null;
    readonly createdAt: number;
    /** The WebAuthn user handle: 32 random bytes, never derived from the email. */
    readonly webauthnUserId: Uint8Array;
}

export interface OrganizationRecord {
    readonly id: OrgId;
    readonly kind: 'personal' | 'team';
    readonly name: string | null;
    readonly createdAt: number;
}

export interface MembershipRecord {
    readonly orgId: OrgId;
    readonly userId: UserId;
    readonly role: OrgRole;
    readonly createdAt: number;
}

export interface MembershipView extends MembershipRecord {
    readonly org: OrganizationRecord;
}

export type PasskeyAddedVia = 'signup' | 'account' | 'recovery';

export interface PasskeyRecord {
    readonly credentialId: string;
    readonly userId: UserId;
    readonly publicKey: Uint8Array;
    readonly counter: number;
    readonly transports: readonly AuthenticatorTransport[];
    readonly backedUp: boolean;
    /** Lowercase; null when the authenticator sent none or the all-zero one. */
    readonly aaguid: string | null;
    readonly addedVia: PasskeyAddedVia;
    readonly createdAt: number;
    readonly lastUsedAt: number | null;
    readonly counterRegressedAt: number | null;
}

export interface SessionRecord {
    readonly idHash: string;
    readonly userId: UserId;
    readonly activeOrgId: OrgId;
    readonly createdAt: number;
    readonly lastSeenAt: number;
    /** The absolute expiry; the idle timeout is checked against `lastSeenAt`. */
    readonly expiresAt: number;
    readonly steppedUpAt: number | null;
    readonly revokedAt: number | null;
}

export type CeremonyPurpose = 'signup' | 'signin' | 'recovery' | 'step-up' | 'passkey-add' | 'invite';

export interface ChallengeRecord {
    readonly id: string;
    readonly challenge: string;
    readonly purpose: CeremonyPurpose;
    readonly userId: UserId | null;
    readonly tokenHash: string | null;
    readonly webauthnUserId: Uint8Array | null;
    readonly expiresAt: number;
}

export type EmailTokenPurpose = 'signup' | 'recovery';

export interface EmailTokenRecord {
    readonly tokenHash: string;
    readonly purpose: EmailTokenPurpose;
    readonly email: string;
    readonly userId: UserId | null;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly usedAt: number | null;
}

export interface AdminAuditEntry {
    readonly id: string;
    readonly adminUserId: UserId;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly reason: string | null;
    readonly createdAt: number;
}
