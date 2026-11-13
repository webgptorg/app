import { expect, it, vi } from 'vitest';
import { linkWebsiteIdentity } from './website-handoff';
it('links only the authenticated matching mailbox and preserves store conflicts', async () => {
    const link = vi.fn().mockResolvedValue('linked');
    const input = {
        actorId: 'actor',
        actorEmail: 'owner@example.test',
        orgId: 'org',
        identity: { subject: 'subject', email: 'OWNER@example.test', emailVerified: true as const },
        store: { link },
    };
    expect(await linkWebsiteIdentity(input)).toBe('linked');
    expect(link).toHaveBeenCalledWith({ actorId: 'actor', orgId: 'org', subject: 'subject' });
    link.mockResolvedValue('conflict');
    expect(await linkWebsiteIdentity(input)).toBe('conflict');
    link.mockClear();
    expect(await linkWebsiteIdentity({ ...input, actorEmail: 'other@example.test' })).toBe('conflict');
    expect(link).not.toHaveBeenCalled();
});
