/** A verified website identity never grants an engine key, an owner setup token or a fresh step-up. */
export interface WebsiteIdentity {
    readonly subject: string;
    readonly email: string;
    readonly emailVerified: true;
}
export interface WebsiteIdentityLinkStore {
    /** Must bind atomically to this actor's account, preserve an existing binding, reject a different subject. */
    link(input: {
        readonly actorId: string;
        readonly orgId: string;
        readonly subject: string;
    }): Promise<'linked' | 'conflict'>;
}
export async function linkWebsiteIdentity(input: {
    readonly actorId: string;
    readonly actorEmail: string;
    readonly orgId: string;
    readonly identity: WebsiteIdentity;
    readonly store: WebsiteIdentityLinkStore;
}): Promise<'linked' | 'conflict'> {
    if (input.actorEmail.trim().toLowerCase() !== input.identity.email.trim().toLowerCase()) return 'conflict';
    return input.store.link({
        actorId: input.actorId,
        orgId: input.orgId,
        subject: input.identity.subject,
    });
}
