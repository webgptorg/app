import { expect, it, vi } from 'vitest';

import { orgAuditEntryIdSchema, orgIdSchema, userIdSchema } from '../ids';
import { linkWebsiteIdentity } from './website-handoff';

it('links only the authenticated matching mailbox and preserves store conflicts', async () => {
    const link = vi.fn().mockResolvedValue('linked');
    const input = {
        actorId: userIdSchema.parse('a'.repeat(26)),
        actorEmail: 'owner@example.test',
        orgId: orgIdSchema.parse('o'.repeat(26)),
        identity: { subject: 'subject', email: ' OWNER@example.test', emailVerified: true as const },
        auditId: orgAuditEntryIdSchema.parse('e'.repeat(26)),
        at: 1,
        store: { link },
    };
    expect(await linkWebsiteIdentity(input)).toBe('linked');
    expect(link).toHaveBeenCalledWith({
        actorId: input.actorId,
        orgId: input.orgId,
        subject: 'subject',
        auditId: input.auditId,
        at: 1,
    });
    link.mockResolvedValue('conflict');
    expect(await linkWebsiteIdentity(input)).toBe('conflict');
    link.mockClear();
    expect(await linkWebsiteIdentity({ ...input, actorEmail: 'other@example.test' })).toBe('email-mismatch');
    expect(link).not.toHaveBeenCalled();
});
