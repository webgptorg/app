import { describe, expect, it } from 'vitest';

import { orgRoleSchema, platformRoleSchema } from './roles';

describe('roles', () => {
    it('accept only the roles v0 knows', () => {
        expect(orgRoleSchema.parse('owner')).toBe('owner');
        expect(orgRoleSchema.safeParse('admin').success).toBe(false);
        expect(platformRoleSchema.options).toEqual(['none', 'admin']);
        expect(platformRoleSchema.safeParse('root').success).toBe(false);
    });
});
