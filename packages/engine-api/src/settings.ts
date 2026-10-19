import { z } from 'zod';

import { AgentVisibility } from './agents';
import { SemVer } from './common';
import { defineRoute } from './route';

export const UPDATE_POLICIES = ['auto', 'manual', 'pinned'] as const;
export const UpdatePolicyName = z.enum(UPDATE_POLICIES);

/** `pinnedVersion` is set exactly when `policy` is `pinned`. */
export const UpdatePolicy = z.strictObject({ policy: UpdatePolicyName, pinnedVersion: SemVer.nullable() });
export type UpdatePolicy = z.infer<typeof UpdatePolicy>;

export const SetUpdatePolicyBody = z.discriminatedUnion('policy', [
    z.strictObject({ policy: z.enum(['auto', 'manual']) }),
    z.strictObject({ policy: z.literal('pinned'), pinnedVersion: SemVer }),
]);

export const Settings = z.strictObject({
    name: z.string().trim().min(1).max(128),
    defaultAgentVisibility: AgentVisibility,
    updatePolicy: UpdatePolicy,
});
export type Settings = z.infer<typeof Settings>;

/** The update policy has its own route, because changing it needs step-up. */
export const UpdateSettingsBody = z.strictObject({
    name: z.string().trim().min(1).max(128).optional(),
    defaultAgentVisibility: AgentVisibility.optional(),
});

export const SETTINGS_ROUTES = {
    getSettings: defineRoute({
        id: 'getSettings',
        method: 'GET',
        path: '/settings',
        summary: 'Get engine settings',
        permission: 'settings.manage',
        responses: { 200: { kind: 'json', schema: Settings } },
    }),
    updateSettings: defineRoute({
        id: 'updateSettings',
        method: 'PATCH',
        path: '/settings',
        summary: 'Change engine settings',
        permission: 'settings.manage',
        body: { kind: 'json', schema: UpdateSettingsBody },
        responses: { 200: { kind: 'json', schema: Settings } },
    }),
    setUpdatePolicy: defineRoute({
        id: 'setUpdatePolicy',
        method: 'PUT',
        path: '/settings/update-policy',
        summary: 'Set the engine update policy',
        permission: 'settings.manage',
        body: { kind: 'json', schema: SetUpdatePolicyBody },
        responses: { 200: { kind: 'json', schema: UpdatePolicy } },
        stepUp: true,
    }),
} as const;
