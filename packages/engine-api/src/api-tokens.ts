import { z } from 'zod';

import { ApiTokenId, MemberId, PageQuery, Timestamp, pageOf } from './common';
import { Permission } from './permissions';
import { defineRoute } from './route';

export const API_TOKEN_STATUSES = ['active', 'revoked'] as const;

/** Metadata only: the engine stores tokens hashed and never returns one after creation. */
export const ApiToken = z.strictObject({
    id: ApiTokenId,
    name: z.string().trim().min(1).max(128),
    /** A token acts with at most these permissions, and never more than its creator holds. */
    permissions: z.array(Permission).min(1),
    status: z.enum(API_TOKEN_STATUSES),
    createdBy: MemberId,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    lastUsedAt: Timestamp.nullable(),
});
export type ApiToken = z.infer<typeof ApiToken>;
export const ApiTokenPage = pageOf(ApiToken);

export const ApiTokenParams = z.strictObject({ apiTokenId: ApiTokenId });

export const CreateApiTokenBody = z.strictObject({
    name: z.string().trim().min(1).max(128),
    permissions: z.array(Permission).min(1),
    expiresAt: Timestamp,
});

/** The only response in the API that carries a credential; shown once. */
export const CreateApiTokenResult = z.strictObject({
    apiToken: ApiToken,
    token: z.string().min(16).max(512),
});

export const API_TOKEN_ROUTES = {
    listApiTokens: defineRoute({
        id: 'listApiTokens',
        method: 'GET',
        path: '/api-tokens',
        summary: 'List API tokens, newest first',
        permission: 'api-tokens.manage',
        query: PageQuery,
        responses: { 200: { kind: 'json', schema: ApiTokenPage } },
    }),
    createApiToken: defineRoute({
        id: 'createApiToken',
        method: 'POST',
        path: '/api-tokens',
        summary: 'Create an API token; the token is returned only in this response',
        permission: 'api-tokens.manage',
        body: { kind: 'json', schema: CreateApiTokenBody },
        responses: { 201: { kind: 'json', schema: CreateApiTokenResult } },
        stepUp: true,
    }),
    revokeApiToken: defineRoute({
        id: 'revokeApiToken',
        method: 'POST',
        path: '/api-tokens/{apiTokenId}/revoke',
        summary: 'Revoke an API token (idempotent)',
        permission: 'api-tokens.manage',
        params: ApiTokenParams,
        responses: { 200: { kind: 'json', schema: ApiToken } },
    }),
} as const;
