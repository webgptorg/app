import type { OrgAuditEntryId, OrgId, UserId } from '../ids';

/** A verified website identity never grants an engine key, an owner setup token or a fresh step-up. */
export interface WebsiteIdentity {
    readonly subject: string;
    readonly email: string;
    readonly emailVerified: true;
}

export interface WebsiteIdentityLinkStore {
    /**
     * Binds atomically, with its `org_audit_log` entry: keeps an identical binding, and refuses a subject already bound
     * to another organization or an organization already bound to another subject.
     */
    link(input: {
        readonly actorId: UserId;
        readonly orgId: OrgId;
        readonly subject: string;
        readonly auditId: OrgAuditEntryId;
        readonly at: number;
    }): Promise<'linked' | 'conflict'>;
}

export type LinkOutcome = 'linked' | 'conflict' | 'email-mismatch';

/** Only the signed-in account whose own address the website verified may link; the website never decides who that is. */
export async function linkWebsiteIdentity(input: {
    readonly actorId: UserId;
    readonly actorEmail: string;
    readonly orgId: OrgId;
    readonly identity: WebsiteIdentity;
    readonly auditId: OrgAuditEntryId;
    readonly at: number;
    readonly store: WebsiteIdentityLinkStore;
}): Promise<LinkOutcome> {
    if (input.actorEmail.trim().toLowerCase() !== input.identity.email.trim().toLowerCase()) return 'email-mismatch';
    return input.store.link({
        actorId: input.actorId,
        orgId: input.orgId,
        subject: input.identity.subject,
        auditId: input.auditId,
        at: input.at,
    });
}
