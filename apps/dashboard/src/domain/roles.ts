import { z } from 'zod';

/**
 * Owners run billing and roles, admins run teams and people, members use their teams (ADR 0018). The column has no
 * CHECK, so adding a role needs no table rebuild.
 */
export const orgRoleSchema = z.enum(['owner', 'admin', 'member']);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const platformRoleSchema = z.enum(['none', 'admin']);
export type PlatformRole = z.infer<typeof platformRoleSchema>;
