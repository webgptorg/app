import { describe, expect, it } from 'vitest';

import { orgRoleSchema, platformRoleSchema } from './roles';

describe('roles', () => {
    it('accept only the roles teams know (ADR 0018)', () => {
        expect(orgRoleSchema.options).toEqual(['owner', 'admin', 'member']);
        expect(orgRoleSchema.safeParse('viewer').success).toBe(false);
        expect(platformRoleSchema.options).toEqual(['none', 'admin']);
        expect(platformRoleSchema.safeParse('root').success).toBe(false);
    });
});
