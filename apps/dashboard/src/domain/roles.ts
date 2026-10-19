import { z } from 'zod';

/** Grows with team organizations; the column has no CHECK, so adding a role needs no table rebuild. */
export const orgRoleSchema = z.enum(['owner']);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const platformRoleSchema = z.enum(['none', 'admin']);
export type PlatformRole = z.infer<typeof platformRoleSchema>;
