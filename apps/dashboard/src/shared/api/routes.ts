import {
    CpuLoad,
    Ed25519Signature,
    EngineId,
    EngineVersion,
    Hostname,
    LinkCode,
    MAX_REGISTRY_HOSTNAMES,
    MAX_RELAYS,
    RegistrationMode,
    Timestamp,
    UpdateState,
} from '@ptbk/protocol';
import { z } from 'zod';

import {
    billingStatusSchema,
    checkoutReturnPageSchema,
    featureSchema,
    planIdSchema,
    planNameSchema,
    planPriceSchema,
    problemStatusSchema,
    quotaSchema,
} from '../billing';
import { engineLabelSchema } from '../engine-label';
import { teamNameSchema } from '../team-name';
import { environmentSchema } from '../environment';
import { docsAnchorSchema, installPathIdSchema, installPathLabelKeySchema } from '../install-paths';
import { defineRoute, NO_CONTENT, NO_INPUT } from './contract';
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
    /** The provider's name when its AAGUID is known ("Google Password Manager"); null otherwise. */
    provider: z.string().min(1).max(100).nullable(),
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
    name: planNameSchema,
    /** Null where the plan catalogue does not state the price; Checkout always shows it. */
    price: planPriceSchema.nullable(),
    features: z.array(featureSchema),
    /** `limit: null` is unlimited. */
    quotas: z.array(z.strictObject({ quota: quotaSchema, limit: quotaLimitSchema })),
    /** Days of free trial; Checkout grants them only while the organization's `trialAvailable` holds. */
    trialDays: z.int().min(1).max(30).nullable(),
});
export type PlanView = z.infer<typeof planViewSchema>;

export const billingViewSchema = z.strictObject({
    status: billingStatusSchema,
    /** End of the paid or trial period; null without a subscription. */
    currentPeriodEnd: timestampSchema.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    /** The plan the entitlements come from: the subscribed one, or `none`. For display only; gate on `entitlements`. */
    planId: planIdSchema,
    /** Null for `none`, which the SPA names itself. */
    planName: planNameSchema.nullable(),
    /** A provider customer exists, so the portal has payment methods and invoices to show. */
    hasBillingAccount: z.boolean(),
    /** No live subscription: Checkout may start one. */
    canSubscribe: z.boolean(),
    /** The organization never had a trial: a plan with `trialDays` starts with one (once per organization). */
    trialAvailable: z.boolean(),
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

/** Shown once, at issuance; no endpoint returns the code again (the dashboard keeps only its SHA-256). */
export const linkCodeViewSchema = z.strictObject({
    /** Not a secret and grants nothing: the link page polls the code's state by it, and keeps it in its URL. */
    linkCodeId: idSchema,
    linkCode: LinkCode,
    /** One per configured install path, in tab order, each with the code filled in once; may span lines. */
    installCommands: z
        .array(
            z.strictObject({
                id: installPathIdSchema,
                labelKey: installPathLabelKeySchema,
                command: z.string().max(1024),
                docsAnchor: docsAnchorSchema,
            }),
        )
        .min(1)
        .max(installPathIdSchema.options.length),
    /** The public install guide; each path's `docsAnchor` is a heading in it. */
    installGuideUrl: z.url({ protocol: /^https$/ }).max(512),
    expiresAt: timestampSchema,
});
export type LinkCodeView = z.infer<typeof linkCodeViewSchema>;

/** Whether `/engines/new` may offer a link code: the plan step and the engine-limit banner come before any code. */
export const linkEligibilityViewSchema = z.strictObject({
    eligibility: z.enum(['allowed', 'not-entitled', 'engine-limit']),
    /** The configured link-code lifetime, for the page's intro. */
    linkCodeTtlS: z.int().min(1).max(86_400),
    /** The public install guide, for the progress panel's troubleshooting links, after a reload too. */
    installGuideUrl: z.url({ protocol: /^https$/ }).max(512),
});
export type LinkEligibilityView = z.infer<typeof linkEligibilityViewSchema>;

/** A link code's state; never the code or its hash. A used code stays `linked`, even past its expiry. */
export const linkCodeStatusViewSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('pending'), expiresAt: timestampSchema }),
    z.strictObject({ status: z.literal('expired') }),
    z.strictObject({ status: z.literal('linked'), engineId: EngineId, hostname: Hostname }),
]);
export type LinkCodeStatusView = z.infer<typeof linkCodeStatusViewSchema>;

/** What C-03's registry entry carries besides the default hostname; the server refuses more. */
const MAX_CUSTOM_HOSTNAMES = MAX_REGISTRY_HOSTNAMES - 1;
/** What an admin may type: the server normalises and validates it, and answers `invalid-hostname` with a reason. */
const MAX_HOSTNAME_INPUT = 1024;

export const customHostnameViewSchema = z.strictObject({
    hostname: Hostname,
    /** Only `active` hostnames reach relays, which check the claim and the CNAME again on their own. */
    status: z.enum(['pending-dns', 'active']),
    /** The last DNS check with a definite answer; null before the first. */
    dnsCheckedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
});
export type CustomHostnameView = z.infer<typeof customHostnameViewSchema>;

/** What a DNS check found: one CNAME and its target, no CNAME (or no such name), or no answer at all. */
export const cnameLookupViewSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('cname'), target: Hostname }),
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({ kind: z.literal('error') }),
]);
export type CnameLookupView = z.infer<typeof cnameLookupViewSchema>;

const adminEngineParams = z.strictObject({ engineId: EngineId });
const adminHostnameParams = z.strictObject({ engineId: EngineId, hostname: Hostname });

/**
 * `unknown`: the engine's status object did not answer in time; the rest of the list is unaffected. `owner-pending`: online,
 * but its heartbeat counts no member yet, so nobody has set up the owner's passkey on the engine.
 */
export const engineDisplayStatusSchema = z.enum([
    'suspended',
    'never-seen',
    'owner-pending',
    'online',
    'offline',
    'unknown',
]);
export type EngineDisplayStatusView = z.infer<typeof engineDisplayStatusSchema>;

const countSchema = z.int().min(0);

/** The last accepted heartbeat, field for field as the dashboard stores it (D-05): numbers and closed enums only. */
export const heartbeatViewSchema = z.strictObject({
    seq: countSchema,
    /** When the engine signed it (RFC 3339). */
    ts: Timestamp,
    receivedAt: timestampSchema,
    version: EngineVersion,
    uptimeS: countSchema,
    /** Rounded by the engine to the nearest ten. */
    diskPct: z.int().min(0).max(100),
    ramPct: z.int().min(0).max(100),
    cpuLoad: CpuLoad,
    update: UpdateState,
    agents: countSchema,
    members: countSchema,
});
export type HeartbeatView = z.infer<typeof heartbeatViewSchema>;

/** Registry data and heartbeat numbers only; nothing from inside the engine (AGENTS.md rule 2). */
export const engineViewSchema = z.strictObject({
    engineId: EngineId,
    /** The owner's own name for it, typed in the dashboard (account metadata); null until they give one. */
    label: engineLabelSchema.nullable(),
    /** `<engineId>.<engine domain>`, as stored at registration: the only address the SPA links to. */
    hostname: Hostname,
    /** Active custom hostnames (D-08); shown, never linked or loaded. */
    customHostnames: z.array(Hostname).max(MAX_CUSTOM_HOSTNAMES),
    mode: RegistrationMode,
    /** The version the engine registered with; the heartbeat carries the running one. */
    registeredVersion: EngineVersion,
    status: engineDisplayStatusSchema,
    /** Who suspended it, when it is suspended: the owner (revoked, permanent) or the platform. */
    suspendedBy: z.enum(['owner', 'platform']).nullable(),
    createdAt: timestampSchema,
    /** Null until the first heartbeat, and when the status could not be read. */
    lastSeenAt: timestampSchema.nullable(),
    /** Null before the first heartbeat, after the 30-day retention purge, and when the status could not be read. */
    heartbeat: heartbeatViewSchema.nullable(),
    /**
     * Relays that currently hold a ready tunnel for it, as they report it (R-07). Null when no relay has reported in
     * the last 3 minutes, or presence could not be read: then nothing is known about reachability.
     */
    reachableRelays: z.int().min(0).max(MAX_RELAYS).nullable(),
});
export type EngineView = z.infer<typeof engineViewSchema>;

const engineParams = z.strictObject({ engineId: EngineId });

/** An engine as a platform admin sees it (I-05): registry data and our status for it, any organization's. */
export const adminEngineViewSchema = z.strictObject({
    engineId: EngineId,
    orgId: idSchema,
    hostname: Hostname,
    mode: RegistrationMode,
    registeredVersion: EngineVersion,
    status: z.enum(['active', 'suspended']),
    /** Who suspended it: the owner (revoked, permanent) or the platform (can be lifted here). */
    suspendedBy: z.enum(['owner', 'platform']).nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});
export type AdminEngineView = z.infer<typeof adminEngineViewSchema>;

/** At most a ticket or report reference and a sentence; it lands in the audit log, never with the owner. */
export const SUSPENSION_REASON_MAX = 500;
const suspensionInput = {
    ...NO_INPUT,
    params: adminEngineParams,
    body: z.strictObject({ reason: z.string().trim().min(1).max(SUSPENSION_REASON_MAX) }),
    maxBodyBytes: 4096,
} as const;

/** Where the SPA sends the browser, top level: Stripe Checkout or the portal, or back to our own page with the fake. */
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

/** A team as the SPA shows it (ADR 0018): its name, its engine if linked, and how many people are in it. */
export const teamViewSchema = z.strictObject({
    teamId: idSchema,
    name: teamNameSchema,
    /** Null until its engine registers; at most one in v1. */
    engineId: EngineId.nullable(),
    memberCount: z.int().min(0),
    /** Whether the signed-in user is in it; owners and admins also see teams they are not in. */
    isMember: z.boolean(),
    createdAt: timestampSchema,
});
export type TeamView = z.infer<typeof teamViewSchema>;

const orgRoleViewSchema = z.enum(['owner', 'admin', 'member']);

export const personViewSchema = z.strictObject({
    userId: idSchema,
    email: z.string(),
    role: orgRoleViewSchema,
    joinedAt: timestampSchema,
});
export type PersonView = z.infer<typeof personViewSchema>;

/** Someone in a team, with what the dashboard knows of their access to its engine (ADR 0018). */
export const teamMemberViewSchema = personViewSchema.extend({ access: z.enum(['none', 'waiting', 'approved']) });
export type TeamMemberView = z.infer<typeof teamMemberViewSchema>;

export const orgMemberViewSchema = personViewSchema.extend({ teamIds: z.array(idSchema) });
export type OrgMemberView = z.infer<typeof orgMemberViewSchema>;

/** A pending invitation; never its token. */
export const inviteViewSchema = z.strictObject({
    inviteId: idSchema,
    email: z.string(),
    role: orgRoleViewSchema,
    teamIds: z.array(idSchema),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
});
export type InviteView = z.infer<typeof inviteViewSchema>;

/** At most this many teams per invitation, and addresses per request. */
export const MAX_INVITE_TEAMS = 50;
export const MAX_INVITE_EMAILS = 20;

const teamParams = z.strictObject({ teamId: idSchema });
const teamMemberParams = z.strictObject({ teamId: idSchema, userId: idSchema });
const userParams = z.strictObject({ userId: idSchema });
const inviteParams = z.strictObject({ inviteId: idSchema });
const teamNameInput = {
    ...NO_INPUT,
    body: z.strictObject({ name: teamNameSchema }),
    maxBodyBytes: SMALL_BODY_BYTES,
} as const;
const inviteTokenInput = {
    ...NO_INPUT,
    body: z.strictObject({ token: emailTokenSchema }),
    maxBodyBytes: SMALL_BODY_BYTES,
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

    /** I-05: where to report abuse; for `/abuse` and a suspended engine's page, signed in or not. */
    getAbuseContact: defineRoute({
        method: 'GET',
        path: '/api/abuse-contact',
        auth: 'public',
        permission: null,
        rateLimit: 'public-read-ip',
        input: NO_INPUT,
        output: z.strictObject({ email: z.email().max(254) }),
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
        input: {
            ...NO_INPUT,
            // `returnTo` names a page from an allowlist, never a URL; `/billing` when absent.
            body: z.strictObject({ planId: planIdSchema, returnTo: checkoutReturnPageSchema.optional() }),
            maxBodyBytes: SMALL_BODY_BYTES,
        },
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

    /** I-05: any organization's engine, for abuse handling. */
    adminGetEngine: defineRoute({
        method: 'GET',
        path: '/api/admin/engines/:engineId',
        auth: 'session',
        permission: 'admin.engine.read',
        rateLimit: null,
        input: { ...NO_INPUT, params: adminEngineParams },
        output: z.strictObject({ engine: adminEngineViewSchema }),
        errorCodes: [],
    }),
    /**
     * Relays close the engine's tunnel within one registry TTL and refuse new ones; heartbeats and registration are
     * refused; its custom hostnames leave the registry. An engine already suspended (or revoked) stays as it is.
     */
    adminSuspendEngine: defineRoute({
        method: 'POST',
        path: '/api/admin/engines/:engineId/suspend',
        auth: 'session',
        permission: 'admin.engine.suspend',
        rateLimit: null,
        input: suspensionInput,
        output: z.strictObject({ engine: adminEngineViewSchema }),
        errorCodes: [],
    }),
    /** Lifts a platform suspension; `owner-revoked` (409) for an engine its owner revoked, which stays revoked. */
    adminUnsuspendEngine: defineRoute({
        method: 'POST',
        path: '/api/admin/engines/:engineId/unsuspend',
        auth: 'session',
        permission: 'admin.engine.suspend',
        rateLimit: null,
        input: suspensionInput,
        output: z.strictObject({ engine: adminEngineViewSchema }),
        errorCodes: ['owner-revoked'],
    }),

    /** D-08: an engine's custom hostnames, for platform admins, with the CNAME target the customer must set. */
    adminListHostnames: defineRoute({
        method: 'GET',
        path: '/api/admin/engines/:engineId/hostnames',
        auth: 'session',
        permission: 'admin.hostnames.read',
        rateLimit: null,
        input: { ...NO_INPUT, params: adminEngineParams },
        output: z.strictObject({
            engineId: EngineId,
            orgId: idSchema,
            /** C-03's `expectedCnameTarget`: the engine's default hostname, never a relay name. */
            expectedTarget: Hostname,
            hostnames: z.array(customHostnameViewSchema).max(MAX_CUSTOM_HOSTNAMES),
        }),
        errorCodes: [],
    }),
    /** Stored as `pending-dns` once the engine's claim verifies; the hostname comes back normalised. */
    adminAddHostname: defineRoute({
        method: 'POST',
        path: '/api/admin/engines/:engineId/hostnames',
        auth: 'session',
        permission: 'admin.hostnames.manage',
        rateLimit: null,
        input: {
            ...NO_INPUT,
            params: adminEngineParams,
            body: z.strictObject({
                hostname: z.string().min(1).max(MAX_HOSTNAME_INPUT),
                claimSig: Ed25519Signature,
            }),
            maxBodyBytes: 4096,
        },
        output: z.strictObject({ hostname: customHostnameViewSchema }),
        errorCodes: ['invalid-hostname', 'reserved-domain', 'taken', 'bad-claim', 'limit-reached'],
    }),
    /** `active` exactly when the CNAME points at the engine's default hostname; `lookup` says what DNS answered. */
    adminCheckHostname: defineRoute({
        method: 'POST',
        path: '/api/admin/engines/:engineId/hostnames/:hostname/check',
        auth: 'session',
        permission: 'admin.hostnames.manage',
        rateLimit: null,
        input: { ...NO_INPUT, params: adminHostnameParams },
        output: z.strictObject({ hostname: customHostnameViewSchema, lookup: cnameLookupViewSchema }),
        errorCodes: [],
    }),
    /** Relays stop routing it within one registry cache TTL (5 minutes). */
    adminRemoveHostname: defineRoute({
        method: 'POST',
        path: '/api/admin/engines/:engineId/hostnames/:hostname/remove',
        auth: 'session',
        permission: 'admin.hostnames.manage',
        rateLimit: null,
        input: { ...NO_INPUT, params: adminHostnameParams },
        output: emptySchema,
        errorCodes: [],
    }),

    /** For the session's active organization only: the organization is never a request field. */
    createLinkCode: defineRoute({
        method: 'POST',
        path: '/api/engines/link-codes',
        auth: 'session',
        permission: 'engine.link',
        rateLimit: null,
        input: NO_INPUT,
        output: linkCodeViewSchema,
        // `rate-limited` (429) is common: at most 5 active codes and 10 per hour per organization.
        errorCodes: ['not-entitled', 'engine-limit'],
    }),
    /** Entitlements only; the link-code rate limits answer at issuance. */
    linkEligibility: defineRoute({
        method: 'GET',
        path: '/api/engines/link-eligibility',
        auth: 'session',
        permission: 'engine.link',
        rateLimit: null,
        input: NO_INPUT,
        output: linkEligibilityViewSchema,
        errorCodes: [],
    }),
    /** A code of another organization is `not-found`, like one that does not exist. */
    getLinkCode: defineRoute({
        method: 'GET',
        path: '/api/engines/link-codes/:linkCodeId',
        auth: 'session',
        permission: 'engine.link',
        rateLimit: null,
        input: { ...NO_INPUT, params: z.strictObject({ linkCodeId: idSchema }) },
        output: linkCodeStatusViewSchema,
        errorCodes: [],
    }),

    /** The active organization's engines, oldest first, with live status (D-06). */
    listEngines: defineRoute({
        method: 'GET',
        path: '/api/engines',
        auth: 'session',
        permission: 'engine.read',
        rateLimit: null,
        input: NO_INPUT,
        output: z.strictObject({ engines: z.array(engineViewSchema) }),
        errorCodes: [],
    }),
    /** D-12: the configured install guide, for the engine page's troubleshooting link; the same URL D-11 offers. */
    getInstallGuide: defineRoute({
        method: 'GET',
        path: '/api/install-guide',
        auth: 'session',
        permission: 'engine.read',
        rateLimit: null,
        input: NO_INPUT,
        output: z.strictObject({ url: z.url({ protocol: /^https$/ }).max(512) }),
        errorCodes: [],
    }),
    /** An engine of another organization is `not-found`, like one that does not exist. */
    getEngine: defineRoute({
        method: 'GET',
        path: '/api/engines/:engineId',
        auth: 'session',
        permission: 'engine.read',
        rateLimit: null,
        input: { ...NO_INPUT, params: engineParams },
        output: z.strictObject({ engine: engineViewSchema }),
        errorCodes: [],
    }),
    /**
     * Permanent: relays stop routing the engine ID within their registry TTL. Sensitive (`recovery-cooldown`) and needs
     * a fresh step-up (`step-up-required`); revoking an engine already revoked changes nothing.
     */
    revokeEngine: defineRoute({
        method: 'POST',
        path: '/api/engines/:engineId/revoke',
        auth: 'session',
        permission: 'engine.revoke',
        rateLimit: null,
        input: { ...NO_INPUT, params: engineParams },
        output: z.strictObject({ engine: engineViewSchema }),
        errorCodes: [],
    }),
    /** Sets the owner's label, or clears it with `null`; the same label again changes nothing and logs nothing. */
    renameEngine: defineRoute({
        method: 'POST',
        path: '/api/engines/:engineId/label',
        auth: 'session',
        permission: 'engine.rename',
        rateLimit: null,
        input: {
            ...NO_INPUT,
            params: engineParams,
            body: z.strictObject({ label: engineLabelSchema.nullable() }),
            maxBodyBytes: SMALL_BODY_BYTES,
        },
        output: z.strictObject({ engine: engineViewSchema }),
        errorCodes: [],
    }),

    /** Only to an organization the user is a member of; any other is `not-found`. */
    setActiveOrg: defineRoute({
        method: 'POST',
        path: '/api/session/active-org',
        auth: 'session',
        permission: 'session.manage',
        rateLimit: null,
        input: { ...NO_INPUT, body: z.strictObject({ orgId: idSchema }), maxBodyBytes: SMALL_BODY_BYTES },
        output: sessionViewSchema,
        errorCodes: [],
    }),

    // Teams (ADR 0018). A team of another organization, or one a member is not in, is `not-found`.
    listTeams: defineRoute({
        method: 'GET',
        path: '/api/teams',
        auth: 'session',
        permission: 'team.read',
        rateLimit: null,
        input: NO_INPUT,
        output: z.strictObject({ teams: z.array(teamViewSchema) }),
        errorCodes: [],
    }),
    createTeam: defineRoute({
        method: 'POST',
        path: '/api/teams',
        auth: 'session',
        permission: 'team.manage',
        rateLimit: null,
        input: teamNameInput,
        output: z.strictObject({ team: teamViewSchema }),
        errorCodes: [],
    }),
    getTeam: defineRoute({
        method: 'GET',
        path: '/api/teams/:teamId',
        auth: 'session',
        permission: 'team.read',
        rateLimit: null,
        input: { ...NO_INPUT, params: teamParams },
        output: z.strictObject({
            team: teamViewSchema,
            members: z.array(teamMemberViewSchema),
            /** Taken out of the team; the engine has not confirmed the removal yet. */
            removing: z.array(personViewSchema),
            /** Pending invitations that name this team. */
            invites: z.array(inviteViewSchema),
        }),
        errorCodes: [],
    }),
    renameTeam: defineRoute({
        method: 'POST',
        path: '/api/teams/:teamId/name',
        auth: 'session',
        permission: 'team.manage',
        rateLimit: null,
        input: { ...teamNameInput, params: teamParams },
        output: z.strictObject({ team: teamViewSchema }),
        errorCodes: [],
    }),
    /** Revokes the team's engine, as `revokeEngine` does, and removes everyone from it. Needs a step-up. */
    deleteTeam: defineRoute({
        method: 'POST',
        path: '/api/teams/:teamId/delete',
        auth: 'session',
        permission: 'team.delete',
        rateLimit: null,
        input: { ...NO_INPUT, params: teamParams },
        output: NO_CONTENT,
        errorCodes: [],
    }),
    /** A link code whose engine joins this team; the team must not have an engine yet. */
    createTeamLinkCode: defineRoute({
        method: 'POST',
        path: '/api/teams/:teamId/link-codes',
        auth: 'session',
        permission: 'engine.link',
        rateLimit: null,
        input: { ...NO_INPUT, params: teamParams },
        output: linkCodeViewSchema,
        errorCodes: ['not-entitled', 'engine-limit', 'team-has-engine'],
    }),
    /**
     * "Open" for someone in the team: a signed access ticket and the engine's join page to take it to. The ticket rides
     * in the URL's fragment, so it reaches neither the relay nor a log. `not-found` without an active engine, or for
     * someone not in the team; `unavailable` (503) when the dashboard has no member key.
     */
    createAccessTicket: defineRoute({
        method: 'POST',
        path: '/api/teams/:teamId/access-ticket',
        auth: 'session',
        permission: 'team.read',
        rateLimit: null,
        input: { ...NO_INPUT, params: teamParams },
        output: z.strictObject({ url: z.url({ protocol: /^https$/ }).max(4096), expiresAt: timestampSchema }),
        errorCodes: ['unavailable'],
    }),
    /** Someone already in the organization; `not-member` otherwise (invite them instead). */
    addTeamMember: defineRoute({
        method: 'POST',
        path: '/api/teams/:teamId/members',
        auth: 'session',
        permission: 'team.members.manage',
        rateLimit: null,
        input: {
            ...NO_INPUT,
            params: teamParams,
            body: z.strictObject({ userId: idSchema }),
            maxBodyBytes: SMALL_BODY_BYTES,
        },
        output: NO_CONTENT,
        errorCodes: ['not-member'],
    }),
    removeTeamMember: defineRoute({
        method: 'POST',
        path: '/api/teams/:teamId/members/:userId/remove',
        auth: 'session',
        permission: 'team.members.manage',
        rateLimit: null,
        input: { ...NO_INPUT, params: teamMemberParams },
        output: NO_CONTENT,
        errorCodes: [],
    }),
    leaveTeam: defineRoute({
        method: 'POST',
        path: '/api/teams/:teamId/leave',
        auth: 'session',
        permission: 'team.leave',
        rateLimit: null,
        input: { ...NO_INPUT, params: teamParams },
        output: NO_CONTENT,
        errorCodes: [],
    }),

    // The organization's people.
    listOrgMembers: defineRoute({
        method: 'GET',
        path: '/api/org/members',
        auth: 'session',
        permission: 'org.members.read',
        rateLimit: null,
        input: NO_INPUT,
        output: z.strictObject({ members: z.array(orgMemberViewSchema), invites: z.array(inviteViewSchema) }),
        errorCodes: [],
    }),
    /** `last-owner` (409): the organization keeps at least one owner. */
    changeOrgRole: defineRoute({
        method: 'POST',
        path: '/api/org/members/:userId/role',
        auth: 'session',
        permission: 'org.roles.manage',
        rateLimit: null,
        input: {
            ...NO_INPUT,
            params: userParams,
            body: z.strictObject({ role: orgRoleViewSchema }),
            maxBodyBytes: SMALL_BODY_BYTES,
        },
        output: NO_CONTENT,
        errorCodes: ['last-owner'],
    }),
    /** Out of every team and the organization. Only an owner removes an owner (`forbidden`, 403). */
    removeOrgMember: defineRoute({
        method: 'POST',
        path: '/api/org/members/:userId/remove',
        auth: 'session',
        permission: 'org.members.manage',
        rateLimit: null,
        input: { ...NO_INPUT, params: userParams },
        output: NO_CONTENT,
        errorCodes: ['last-owner'],
    }),
    leaveOrg: defineRoute({
        method: 'POST',
        path: '/api/org/leave',
        auth: 'session',
        permission: 'org.leave',
        rateLimit: null,
        input: NO_INPUT,
        output: NO_CONTENT,
        errorCodes: ['last-owner'],
    }),

    // Invitations: emailed, single use, valid for 7 days.
    /** People already in the organization are added to the teams at once (`added`); only owners invite owners. */
    createInvites: defineRoute({
        method: 'POST',
        path: '/api/invites',
        auth: 'session',
        permission: 'org.members.manage',
        rateLimit: null,
        input: {
            ...NO_INPUT,
            body: z.strictObject({
                emails: z.array(emailSchema).min(1).max(MAX_INVITE_EMAILS),
                role: orgRoleViewSchema,
                teamIds: z.array(idSchema).max(MAX_INVITE_TEAMS),
            }),
            maxBodyBytes: 16 * 1024,
        },
        output: z.strictObject({
            results: z.array(z.strictObject({ email: z.string(), outcome: z.enum(['invited', 'added']) })),
        }),
        errorCodes: ['invalid-email', 'team-not-found'],
    }),
    resendInvite: defineRoute({
        method: 'POST',
        path: '/api/invites/:inviteId/resend',
        auth: 'session',
        permission: 'org.members.manage',
        rateLimit: null,
        input: { ...NO_INPUT, params: inviteParams },
        output: NO_CONTENT,
        errorCodes: [],
    }),
    revokeInvite: defineRoute({
        method: 'POST',
        path: '/api/invites/:inviteId/revoke',
        auth: 'session',
        permission: 'org.members.manage',
        rateLimit: null,
        input: { ...NO_INPUT, params: inviteParams },
        output: NO_CONTENT,
        errorCodes: [],
    }),
    /** What the invitation page shows before sign-in; an unknown, used, revoked or expired token is `not-found`. */
    previewInvite: defineRoute({
        method: 'POST',
        path: '/api/invites/preview',
        auth: 'public',
        permission: null,
        // Like the other token checks: a 256-bit token cannot be guessed, but probing should still be slow.
        rateLimit: 'verify-ip',
        input: inviteTokenInput,
        output: z.strictObject({
            orgName: z.string().nullable(),
            teamNames: z.array(teamNameSchema),
            email: z.string(),
            expiresAt: timestampSchema,
        }),
        errorCodes: [],
    }),
    /** Joins the invitation's organization and teams; `email-mismatch` (403) when signed in with another address. */
    acceptInvite: defineRoute({
        method: 'POST',
        path: '/api/invites/accept',
        auth: 'session',
        permission: 'invite.accept',
        rateLimit: null,
        input: inviteTokenInput,
        output: z.strictObject({ orgId: idSchema }),
        errorCodes: ['invite-invalid', 'email-mismatch'],
    }),

    /**
     * Dev only, for e2e (X-05) and the dev mailbox page (X-06): mounted only with the fake email adapter, which the
     * config allows in dev alone. Without `to`, every recorded message, oldest first.
     */
    devEmails: defineRoute({
        method: 'GET',
        path: '/api/__dev/emails',
        auth: 'public',
        permission: null,
        rateLimit: 'public-read-ip',
        input: { ...NO_INPUT, query: z.strictObject({ to: emailSchema.optional() }) },
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
