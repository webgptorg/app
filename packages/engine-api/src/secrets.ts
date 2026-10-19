import { z } from 'zod';

import { AgentId, MemberId, PageQuery, SecretId, Timestamp, pageOf } from './common';
import { MAX_SECRET_VALUE_LENGTH } from './constants';
import { defineRoute } from './route';

export const SecretScope = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('engine') }),
    z.strictObject({ kind: z.literal('agent'), agentId: AgentId }),
]);
export type SecretScope = z.infer<typeof SecretScope>;

export const SECRET_STATUSES = ['active', 'revoked'] as const;
export const SecretStatus = z.enum(SECRET_STATUSES);

export const SecretName = z.string().trim().min(1).max(128);

/** Write-only: accepted in requests, never part of any response. */
export const SecretValue = z.string().min(1).max(MAX_SECRET_VALUE_LENGTH);

export const SecretMetadata = z.strictObject({
    id: SecretId,
    name: SecretName,
    scope: SecretScope,
    status: SecretStatus,
    createdBy: MemberId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    lastUsedAt: Timestamp.nullable(),
});
export type SecretMetadata = z.infer<typeof SecretMetadata>;
export const SecretPage = pageOf(SecretMetadata);

export const SECRET_SORTS = ['name', '-name', 'createdAt', '-createdAt', 'lastUsedAt', '-lastUsedAt'] as const;

export const SecretListQuery = PageQuery.extend({
    q: z.string().min(1).max(128).optional(),
    scope: z.enum(['engine', 'agent']).optional(),
    /** Narrows `scope=agent` to one agent. */
    agentId: AgentId.optional(),
    status: SecretStatus.optional(),
    sort: z.enum(SECRET_SORTS).default('name'),
});

export const SecretParams = z.strictObject({ secretId: SecretId });
export const CreateSecretBody = z.strictObject({ name: SecretName, scope: SecretScope, value: SecretValue });
export const ReplaceSecretValueBody = z.strictObject({ value: SecretValue });

export const SECRET_ROUTES = {
    listSecrets: defineRoute({
        id: 'listSecrets',
        method: 'GET',
        path: '/secrets',
        summary: 'List secret metadata',
        permission: 'secrets.read',
        query: SecretListQuery,
        responses: { 200: { kind: 'json', schema: SecretPage } },
    }),
    createSecret: defineRoute({
        id: 'createSecret',
        method: 'POST',
        path: '/secrets',
        summary: 'Store a secret; its value can never be read back',
        permission: 'secrets.manage',
        body: { kind: 'json', schema: CreateSecretBody },
        responses: { 201: { kind: 'json', schema: SecretMetadata } },
        problems: ['name-taken'],
    }),
    replaceSecretValue: defineRoute({
        id: 'replaceSecretValue',
        method: 'PUT',
        path: '/secrets/{secretId}/value',
        summary: "Replace a secret's value",
        permission: 'secrets.manage',
        params: SecretParams,
        body: { kind: 'json', schema: ReplaceSecretValueBody },
        responses: { 200: { kind: 'json', schema: SecretMetadata } },
        problems: ['secret-revoked'],
    }),
    revokeSecret: defineRoute({
        id: 'revokeSecret',
        method: 'POST',
        path: '/secrets/{secretId}/revoke',
        summary: 'Revoke a secret so agents can no longer use it (idempotent)',
        permission: 'secrets.manage',
        params: SecretParams,
        responses: { 200: { kind: 'json', schema: SecretMetadata } },
    }),
    deleteSecret: defineRoute({
        id: 'deleteSecret',
        method: 'DELETE',
        path: '/secrets/{secretId}',
        summary: 'Delete a secret',
        permission: 'secrets.manage',
        params: SecretParams,
        responses: { 204: { kind: 'empty' } },
    }),
} as const;
