import { z } from 'zod';

import { MemberId, OrgId } from './common';
import { Permission, Role } from './permissions';
import { defineRoute } from './route';

/** The signed-in member. The UI renders by `permissions`, never by `role`. */
export const Me = z.strictObject({
    memberId: MemberId,
    orgId: OrgId,
    displayName: z.string().min(1).max(256),
    role: Role,
    permissions: z.array(Permission),
});
export type Me = z.infer<typeof Me>;

export const ME_ROUTES = {
    getMe: defineRoute({
        id: 'getMe',
        method: 'GET',
        path: '/me',
        summary: 'Get the signed-in member and their permissions',
        permission: null,
        responses: { 200: { kind: 'json', schema: Me } },
    }),
} as const;
