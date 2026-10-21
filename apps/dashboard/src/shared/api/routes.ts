import { z } from 'zod';

import { billingStatusSchema, featureSchema, planIdSchema, problemStatusSchema, quotaSchema } from '../billing';
import { environmentSchema } from '../environment';
import { defineRoute, NO_INPUT } from './contract';
import {
    authenticationOptionsSchema,
    authenticationResponseSchema,
    credentialIdSchema,
    registrationOptionsSchema,
    registrationResponseSchema,
} from './webauthn';

const idSchema = z.string().regex(/^[a-z2-7]{26}$/);
const timestampSchema = z.number().int().nonnegative();
/** 256-bit email tokens, base64url; they arrive in the link's fragment and are posted back by the SPA. */
const emailTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const emailSchema = z.string().max(320);
const localeSchema = z.enum(['en', 'cs']);
const roleSchema = z.string().regex(/^[a-z][a-z-]*$/);
const orgKindSchema = z.enum(['personal', 'team']);

const acceptedSchema = z.strictObject({ accepted: z.literal(true) });
const emptySchema = z.strictObject({});
const registrationOptionsResponse = z.strictObject({ options: registrationOptionsSchema });
const authenticationOptionsResponse = z.strictObject({ options: authenticationOptionsSchema });

export const sessionViewSchema = z.strictObject({
    user: z.strictObject({
        id: idSchema,
        email: z.string(),
        locale: localeSchema,
        platformRole: z.enum(['none', 'admin']),
        recoveredAt: timestampSchema.nullable(),
        /** Until then, sensitive actions answer `recovery-cooldown`. */
        recoveryCooldownEndsAt: timestampSchema.nullable(),
    }),
    activeOrg: z.strictObject({
        id: idSchema,
        kind: orgKindSchema,
        name: z.string().nullable(),
        role: roleSchema,
        /** Actions the role allows here, for rendering by capability; never a substitute for the server's checks. */
        permissions: z.array(z.string()),
    }),
    memberships: z.array(
        z.strictObject({ orgId: idSchema, kind: orgKindSchema, name: z.string().nullable(), role: roleSchema }),
    ),
    /** Sensitive admin actions need a step-up when this is null or in the past. */
    steppedUpUntil: timestampSchema.nullable(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const passkeyViewSchema = z.strictObject({
    credentialId: credentialIdSchema,
    addedVia: z.enum(['signup', 'account', 'recovery']),
    createdAt: timestampSchema,
    lastUsedAt: timestampSchema.nullable(),
    backedUp: z.boolean(),
    counterRegressedAt: timestampSchema.nullable(),
});
export type PasskeyView = z.infer<typeof passkeyViewSchema>;

export const sessionSummarySchema = z.strictObject({
    current: z.boolean(),
    createdAt: timestampSchema,
    lastSeenAt: timestampSchema,
    expiresAt: timestampSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

const quotaLimitSchema = z.number().int().nonnegative().nullable();

const planViewSchema = z.strictObject({
    id: planIdSchema,
    features: z.array(featureSchema),
    /** `limit: null` is unlimited. */
    quotas: z.array(z.strictObject({ quota: quotaSchema, limit: quotaLimitSchema })),
});
export type PlanView = z.infer<typeof planViewSchema>;

export const billingViewSchema = z.strictObject({
    status: billingStatusSchema,
    /** End of the paid or trial period; null without a subscription. */
    currentPeriodEnd: timestampSchema.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    /** The plan the entitlements come from: the subscribed one, or `none`. For display only; gate on `entitlements`. */
    planId: planIdSchema,
    /** A provider customer exists, so the portal has payment methods and invoices to show. */
    hasBillingAccount: z.boolean(),
    /** No live subscription: Checkout may start one. */
    canSubscribe: z.boolean(),
    entitlements: z.strictObject({
        features: z.array(featureSchema),
        /** `used` is null where the dashboard does not count usage yet. */
        quotas: z.array(z.strictObject({ quota: quotaSchema, limit: quotaLimitSchema, used: quotaLimitSchema })),
    }),
    /** Plans Checkout offers, in catalogue order. */
    plans: z.array(planViewSchema),
});
export type BillingView = z.infer<typeof billingViewSchema>;

export const problemOrganizationSchema = z.strictObject({
    orgId: idSchema,
    kind: orgKindSchema,
    name: z.string().nullable(),
    status: problemStatusSchema,
    currentPeriodEnd: timestampSchema.nullable(),
    /** When the dashboard last stored the subscription's state. */
    updatedAt: timestampSchema,
});
export type ProblemOrganization = z.infer<typeof problemOrganizationSchema>;

/** Where the SPA sends the browser, top level: Stripe Checkout or the portal, or back to `/billing` with the fake. */
const redirectSchema = z.strictObject({ url: z.url({ protocol: /^https?$/ }).max(2048) });

const ceremonyErrors = ['challenge-invalid', 'webauthn-failed'] as const;

const SMALL_BODY_BYTES = 1024;
/** Attestation objects with certificate chains run to a few kilobytes; base64url and JSON add a third. */
const WEBAUTHN_BODY_BYTES = 64 * 1024;

const emailInput = {
    ...NO_INPUT,
    body: z.strictObject({ email: emailSchema }),
    maxBodyBytes: SMALL_BODY_BYTES,
} as const;
const tokenInput = {
    ...NO_INPUT,
    body: z.strictObject({ token: emailTokenSchema }),
    maxBodyBytes: SMALL_BODY_BYTES,
} as const;
const tokenRegistrationInput = {
    ...NO_INPUT,
    body: z.strictObject({ token: emailTokenSchema, response: registrationResponseSchema }),
    maxBodyBytes: WEBAUTHN_BODY_BYTES,
} as const;
const registrationInput = {
    ...NO_INPUT,
    body: z.strictObject({ response: registrationResponseSchema }),
    maxBodyBytes: WEBAUTHN_BODY_BYTES,
} as const;
const authenticationInput = {
    ...NO_INPUT,
    body: z.strictObject({ response: authenticationResponseSchema }),
    maxBodyBytes: WEBAUTHN_BODY_BYTES,
} as const;

/** The SPA's own API. Every `/api` endpoint is declared here and nowhere else. */
export const apiRoutes = {
    getEnvironment: defineRoute({
        method: 'GET',
        path: '/api/environment',
        auth: 'public',
        permission: null,
        rateLimit: 'public-read-ip',
        input: NO_INPUT,
        output: z.strictObject({ environment: environmentSchema }),
        errorCodes: [],
    }),

    signupStart: defineRoute({
        method: 'POST',
        path: '/api/auth/signup/start',
        auth: 'public',
        permission: null,
        rateLimit: 'signup-start-ip',
        input: emailInput,
        output: acceptedSchema,
        errorCodes: [],
    }),
    signupOptions: defineRoute({
        method: 'POST',
        path: '/api/auth/signup/options',
        auth: 'public',
        permission: null,
        rateLimit: 'options-ip',
        input: tokenInput,
        output: registrationOptionsResponse,
        errorCodes: ['token-invalid'],
    }),
    signupVerify: defineRoute({
        method: 'POST',
        path: '/api/auth/signup/verify',
        auth: 'public',
        permission: null,
        rateLimit: 'verify-ip',
        input: tokenRegistrationInput,
        output: sessionViewSchema,
        errorCodes: [...ceremonyErrors, 'token-invalid', 'conflict'],
    }),

    signinOptions: defineRoute({
        method: 'POST',
        path: '/api/auth/signin/options',
        auth: 'public',
        permission: null,
        rateLimit: 'options-ip',
        input: NO_INPUT,
        output: authenticationOptionsResponse,
        errorCodes: [],
    }),
    signinVerify: defineRoute({
        method: 'POST',
        path: '/api/auth/signin/verify',
        auth: 'public',
        permission: null,
        rateLimit: 'verify-ip',
        input: authenticationInput,
        output: sessionViewSchema,
        errorCodes: [...ceremonyErrors],
    }),

    recoveryRequest: defineRoute({
        method: 'POST',
        path: '/api/auth/recovery/request',
        auth: 'public',
        permission: null,
        rateLimit: 'recovery-request-ip',
        input: emailInput,
        output: acceptedSchema,
        errorCodes: [],
    }),
    recoveryOptions: defineRoute({
        method: 'POST',
        path: '/api/auth/recovery/options',
        auth: 'public',
        permission: null,
        rateLimit: 'options-ip',
        input: tokenInput,
        output: registrationOptionsResponse,
        errorCodes: ['token-invalid'],
    }),
    recoveryVerify: defineRoute({
        method: 'POST',
        path: '/api/auth/recovery/verify',
        auth: 'public',
        permission: null,
        rateLimit: 'verify-ip',
        input: tokenRegistrationInput,
        output: sessionViewSchema,
        errorCodes: [...ceremonyErrors, 'token-invalid', 'conflict'],
    }),

    stepUpOptions: defineRoute({
        method: 'POST',
        path: '/api/auth/step-up/options',
        auth: 'session',
        permission: 'session.manage',
        rateLimit: null,
        input: NO_INPUT,
        output: authenticationOptionsResponse,
        errorCodes: [],
    }),
    stepUpVerify: defineRoute({
        method: 'POST',
        path: '/api/auth/step-up/verify',
        auth: 'session',
        permission: 'session.manage',
        rateLimit: 'verify-ip',
        input: authenticationInput,
        output: z.strictObject({ steppedUpUntil: timestampSchema }),
        errorCodes: [...ceremonyErrors],
    }),
    signout: defineRoute({
        method: 'POST',
        path: '/api/auth/signout',
        auth: 'session',
        permission: 'session.manage',
        rateLimit: null,
        input: NO_INPUT,
        output: emptySchema,
        errorCodes: [],
    }),

    getSession: defineRoute({
        method: 'GET',
        path: '/api/session',
        auth: 'session',
        permission: 'account.read',
        rateLimit: null,
        input: NO_INPUT,
        output: sessionViewSchema,
        errorCodes: [],
    }),
    listSessions: defineRoute({
        method: 'GET',
        path: '/api/sessions',
        auth: 'session',
        permission: 'session.manage',
        rateLimit: null,
        input: NO_INPUT,
        output: z.strictObject({ sessions: z.array(sessionSummarySchema) }),
        errorCodes: [],
    }),
    revokeAllSessions: defineRoute({
        method: 'POST',
        path: '/api/sessions/revoke-all',
        auth: 'session',
        permission: 'session.manage',
        rateLimit: null,
        input: NO_INPUT,
        output: emptySchema,
        errorCodes: [],
    }),

    listPasskeys: defineRoute({
        method: 'GET',
        path: '/api/passkeys',
        auth: 'session',
        permission: 'passkey.manage',
        rateLimit: null,
        input: NO_INPUT,
        output: z.strictObject({ passkeys: z.array(passkeyViewSchema) }),
        errorCodes: [],
    }),
    passkeyOptions: defineRoute({
        method: 'POST',
        path: '/api/passkeys/options',
        auth: 'session',
        permission: 'passkey.manage',
        rateLimit: null,
        input: NO_INPUT,
        output: registrationOptionsResponse,
        errorCodes: [],
    }),
    passkeyVerify: defineRoute({
        method: 'POST',
        path: '/api/passkeys/verify',
        auth: 'session',
        permission: 'passkey.manage',
        rateLimit: 'verify-ip',
        input: registrationInput,
        output: z.strictObject({ passkey: passkeyViewSchema }),
        errorCodes: [...ceremonyErrors, 'conflict'],
    }),
    passkeyDelete: defineRoute({
        method: 'POST',
        path: '/api/passkeys/delete',
        auth: 'session',
        permission: 'passkey.manage',
        rateLimit: null,
        input: {
            ...NO_INPUT,
            body: z.strictObject({ credentialId: credentialIdSchema }),
            maxBodyBytes: 4096,
        },
        output: emptySchema,
        errorCodes: ['last-passkey'],
    }),

    getBilling: defineRoute({
        method: 'GET',
        path: '/api/billing',
        auth: 'session',
        permission: 'billing.read',
        rateLimit: null,
        input: NO_INPUT,
        output: billingViewSchema,
        errorCodes: [],
    }),
    billingCheckout: defineRoute({
        method: 'POST',
        path: '/api/billing/checkout',
        auth: 'session',
        permission: 'billing.manage',
        rateLimit: null,
        input: { ...NO_INPUT, body: z.strictObject({ planId: planIdSchema }), maxBodyBytes: SMALL_BODY_BYTES },
        output: redirectSchema,
        errorCodes: ['unknown-plan', 'already-subscribed'],
    }),
    billingPortal: defineRoute({
        method: 'POST',
        path: '/api/billing/portal',
        auth: 'session',
        permission: 'billing.manage',
        rateLimit: null,
        input: NO_INPUT,
        output: redirectSchema,
        errorCodes: [],
    }),
    adminBilling: defineRoute({
        method: 'GET',
        path: '/api/admin/billing',
        auth: 'session',
        permission: 'admin.billing.read',
        rateLimit: null,
        input: NO_INPUT,
        output: z.strictObject({ organizations: z.array(problemOrganizationSchema) }),
        errorCodes: [],
    }),

    /** Dev only, for e2e (X-05): mounted only with the fake email adapter, which the config allows in dev alone. */
    devEmails: defineRoute({
        method: 'GET',
        path: '/api/__dev/emails',
        auth: 'public',
        permission: null,
        rateLimit: 'public-read-ip',
        input: { ...NO_INPUT, query: z.strictObject({ to: emailSchema }) },
        output: z.strictObject({
            emails: z.array(
                z.strictObject({
                    template: z.string(),
                    to: z.string(),
                    locale: localeSchema,
                    subject: z.string(),
                    text: z.string(),
                }),
            ),
        }),
        errorCodes: [],
    }),
} as const;
