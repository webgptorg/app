import {
    CpuLoad,
    Ed25519Signature,
    EngineId,
    EngineVersion,
    Hostname,
    LinkCode,
    MAX_REGISTRY_HOSTNAMES,
    MAX_RELAYS,
    OwnerHandoff,
    OwnerSetupCommitment,
    RegistrationMode,
    SetupState,
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
import { cloudOffer, providerId, DIGITALOCEAN } from '../vps';
import { engineLabelSchema } from '../engine-label';
import { LINK_CODE_LIMITS } from '../link-code-limits';
import { teamNameSchema } from '../team-name';
import { environmentSchema } from '../environment';
import { docsAnchorSchema, installPathIdSchema, installPathLabelKeySchema } from '../install-paths';
import { installationOptionSchema } from '../engine-installation';
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
    /** False while the dashboard charges nobody (billing `off`): no billing screen, plan step or Checkout exists. */
    billingEnabled: z.boolean(),
    /** True with billing `website` (ADR 0021): the website sells licences, and the billing screen becomes License. */
    licensing: z.boolean(),
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
    vpsProviders: z.array(cloudOffer).optional(),
    linkCode: LinkCode,
    /**
     * `<dashboard origin>/link#<code>`, which `connect --link` takes in place of the code and a dashboard setting. Null
     * only on a plain-http dashboard (local dev), whose URL no engine would accept.
     */
    linkUrl: z
        .url({ protocol: /^https$/ })
        .max(2048)
        .nullable(),
    /** One per configured install path, in tab order, each with the code or link URL filled in once; may span lines. */
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
    /** Optional for legacy configurations; generated and disclosed only alongside the just-issued link code. */
    installationOptions: z.array(installationOptionSchema).length(3).optional(),
    /** The public install guide; each path's `docsAnchor` is a heading in it. */
    installGuideUrl: z.url({ protocol: /^https$/ }).max(512),
    expiresAt: timestampSchema,
});
export type LinkCodeView = z.infer<typeof linkCodeViewSchema>;

/** Whether `/engines/new` may offer a link code: the plan step and the engine-limit banner come before any code. */
export const linkEligibilityViewSchema = z.strictObject({
    eligibility: z.enum(['allowed', 'not-entitled', 'engine-limit']),
    /** The configured link-code lifetime, for the page's intro. */
    linkCodeTtlS: z
        .int()
        .min(1)
        .max(30 * 86_400),
    /** The public install guide, for the progress panel's troubleshooting links, after a reload too. */
    installGuideUrl: z.url({ protocol: /^https$/ }).max(512),
});
export type LinkEligibilityView = z.infer<typeof linkEligibilityViewSchema>;

/** The organization's unused codes still redeemable, newest first: never the code or its hash. */
export const pendingLinkCodesViewSchema = z.strictObject({
    linkCodes: z
        .array(z.strictObject({ linkCodeId: idSchema, createdAt: timestampSchema, expiresAt: timestampSchema }))
        .max(LINK_CODE_LIMITS.active),
});
export type PendingLinkCodesView = z.infer<typeof pendingLinkCodesViewSchema>;

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
 * but its heartbeat counts no member yet, so nobody has set up the owner's passkey on the engine. `setup-pending`:
 * online with an owner, but the engine reports its setup unfinished.
 */
export const engineDisplayStatusSchema = z.enum([
    'suspended',
    'never-seen',
    'owner-pending',
    'setup-pending',
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
    /** Absent: the engine has no browser setup, or reported before it had one; read as set up. */
    setup: SetupState.optional(),
    /** `ready` while the pairing tab may open the engine's setup page (ADR 0023); absent otherwise. */
    ownerHandoff: OwnerHandoff.optional(),
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
/**
 * The pairing tab's `SHA-256` of its owner setup secret (ADR 0023), never the secret. Optional, and so is the body:
 * a request without one issues a code as before.
 */
const linkCodeInput = {
    ...NO_INPUT,
    body: z.strictObject({ ownerSetupCommitment: OwnerSetupCommitment.optional() }).optional(),
    maxBodyBytes: SMALL_BODY_BYTES,
} as const;

const capacitySchema = z.number().int().nonnegative().nullable();

const licenseCheckSchema = z.strictObject({
    outcome: z.enum(['ok', 'warn', 'deny']),
    reason: z.enum(['unlinked', 'missing', 'expired', 'over-limit']).nullable(),
});
export type LicenseCheckView = z.infer<typeof licenseCheckSchema>;

/** ADR 0021's licence view: numbers, dates and the website's own plan name; never a price. */
export const licenseViewSchema = z.strictObject({
    /** The website account linked to the active organization, by whoever linked it. */
    link: z.strictObject({ linkedAt: timestampSchema, linkedByEmail: z.string().nullable() }).nullable(),
    /** `stale`: the website did not answer and this is the last snapshot; `unknown`: there is none. */
    state: z.enum(['current', 'stale', 'unknown']),
    /** Null while unknown; `trial`, `scheduled` and `expired` as the website and the grants say. */
    status: z.enum(['active', 'trial', 'scheduled', 'expired', 'none']).nullable(),
    /** The plan's name as the website writes it; plain text, never an entitlement. */
    label: z.string().max(160).nullable(),
    /** When the licence ends, ended or starts; null without an end date or a licence. */
    term: z.strictObject({ kind: z.enum(['ends', 'ended', 'starts']), at: z.string() }).nullable(),
    checkedAt: z.string().nullable(),
    /** An https page on the website origin, which the server checked; the website's pricing page without a licence. */
    manageUrl: z.string(),
    grants: z.array(
        z.strictObject({
            id: z.string(),
            validFrom: z.string(),
            validUntil: z.string().nullable(),
            active: z.boolean(),
            /** Null is unlimited, zero is none. */
            capabilities: z.strictObject({
                engineProjects: capacitySchema,
                specialists: capacitySchema,
                controllingUsers: capacitySchema,
                harnessInstances: capacitySchema,
                browserProfiles: capacitySchema,
                remoteControl: z.boolean(),
            }),
        }),
    ),
    coverage: z
        .strictObject({
            engines: z.strictObject({
                used: z.number().int().nonnegative(),
                covered: z.number().int().nonnegative(),
                capacity: capacitySchema,
            }),
            people: z.strictObject({ used: z.number().int().nonnegative(), limit: capacitySchema }),
        })
        .nullable(),
    /** Advisory: nothing is ever blocked by it. */
    notice: z.enum(['unlinked', 'missing', 'expired', 'exceeded']).nullable(),
    /** `LICENSE_ENFORCEMENT`: `advisory` warns at the check points, `enforce` may deny there. */
    enforcement: z.enum(['advisory', 'enforce']),
    /** How each check point would answer one more engine or person now. */
    checks: z.strictObject({ engineLink: licenseCheckSchema, memberInvite: licenseCheckSchema }),
});
export type LicenseView = z.infer<typeof licenseViewSchema>;

export const websitePendingViewSchema = z.strictObject({
    /** The address the website verified; sign-up sends the App's own confirmation link to it. */
    email: z.string(),
    accountExists: z.boolean(),
    expiresAt: timestampSchema,
});
export type WebsitePendingView = z.infer<typeof websitePendingViewSchema>;

/** Why `/website-access` was reached without a pending link; the return route's only redirect parameter. */
export const websiteAccessErrorSchema = z.enum(['expired', 'failed']);
export type WebsiteAccessError = z.infer<typeof websiteAccessErrorSchema>;
/**
 * The website sends the browser back with its ticket, with an `error` slug when it could not issue one, or with nothing
 * when the member cancelled there. Each shape is exact, so a ticket never rides along with an error.
 */
const websiteAccessReturnQuerySchema = z.union([
    z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
    z.strictObject({ error: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/) }),
    z.strictObject({}),
]);
/** Attestation objects with certificate chains run to a few kilobytes; base64url and JSON add a third. */
const WEBAUTHN_BODY_BYTES = 64 * 1024;

const emailInput = {
    ...NO_INPUT,
    body: z.strictObject({ email: emailSchema }),
    maxBodyBytes: SMALL_BODY_BYTES,
} as const;
/**
 * `context` says the request comes from an invitation (D-35): the email then speaks of joining, naming an organization
 * only from a pending invitation the server finds for that address.
 */
const recoveryRequestInput = {
    ...NO_INPUT,
    body: z.strictObject({
        email: emailSchema,
        context: z.strictObject({ kind: z.literal('invite') }).optional(),
    }),
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

export const refusedViewSchema = z.strictObject({
    ...personViewSchema.shape,
    outcome: z.enum(['refused-disabled', 'refused-owner']),
});
export type RefusedView = z.infer<typeof refusedViewSchema>;

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

/** An invitation to the signed-in person's own address: the names the inviter chose, never its token. */
export const inviteOfferViewSchema = z.strictObject({
    inviteId: idSchema,
    orgName: z.string().nullable(),
    inviterEmail: z.string().nullable(),
    teamNames: z.array(teamNameSchema),
    expiresAt: timestampSchema,
});
export type InviteOfferView = z.infer<typeof inviteOfferViewSchema>;

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
/**
 * The invitation token from the link's fragment; without it, the server uses the `__Host-` cookie the preview set, so a
 * reload or another tab still finds the invitation (D-31).
 */
const inviteTokenInput = {
    ...NO_INPUT,
    body: z.strictObject({ token: emailTokenSchema.optional() }),
    maxBodyBytes: SMALL_BODY_BYTES,
} as const;
/** Where an accepted invitation put the person: its organization and the teams whose engines they may open next. */
const joinedInviteSchema = z.strictObject({ orgId: idSchema, teamIds: z.array(idSchema) });
const inviteJoinedSchema = z.strictObject({ session: sessionViewSchema, joined: joinedInviteSchema });

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
        input: recoveryRequestInput,
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
        input: linkCodeInput,
        output: linkCodeViewSchema,
        // A full pending list returns 409. Exhausting the hourly issuance budget returns 429.
        errorCodes: ['not-entitled', 'engine-limit', 'link-code-limit'],
    }),
    getVpsLaunch: defineRoute({
        method: 'GET',
        path: '/api/engines/link-codes/:linkCodeId/vps',
        auth: 'session',
        permission: 'engine.link',
        rateLimit: null,
        input: { ...NO_INPUT, params: z.strictObject({ linkCodeId: idSchema }) },
        output: z.strictObject({
            offer: cloudOffer.nullable(),
            reservation: z
                .strictObject({
                    provider: providerId,
                    resourceId: z
                        .string()
                        .regex(/^[0-9]{1,16}$/)
                        .nullable(),
                })
                .nullable(),
        }),
        errorCodes: [],
    }),
    authorizeVps: defineRoute({
        method: 'POST',
        path: '/api/engines/link-codes/:linkCodeId/vps/authorize',
        auth: 'session',
        permission: 'engine.link',
        rateLimit: null,
        input: {
            ...NO_INPUT,
            params: z.strictObject({ linkCodeId: idSchema }),
            maxBodyBytes: 256,
            body: z.strictObject({ provider: providerId }),
        },
        output: z.strictObject({ clientId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }),
        errorCodes: ['vps-unavailable'],
    }),
    launchVps: defineRoute({
        method: 'POST',
        path: '/api/engines/link-codes/:linkCodeId/vps',
        auth: 'session',
        permission: 'engine.link',
        rateLimit: null,
        input: {
            ...NO_INPUT,
            params: z.strictObject({ linkCodeId: idSchema }),
            maxBodyBytes: 2048,
            body: z.strictObject({
                provider: providerId,
                monthlyUsd: z.literal(DIGITALOCEAN.monthlyUsd),
                code: z.string().min(1).max(512),
                verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            }),
        },
        output: z.strictObject({ submitted: z.literal(true) }),
        errorCodes: ['vps-unavailable', 'provider-rejected', 'engine-limit', 'not-entitled'],
    }),
    /** The organization's codes still waiting for an engine, so an owner can see and cancel them. */
    listLinkCodes: defineRoute({
        method: 'GET',
        path: '/api/engines/link-codes',
        auth: 'session',
        permission: 'engine.link',
        rateLimit: null,
        input: NO_INPUT,
        output: pendingLinkCodesViewSchema,
        errorCodes: [],
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
    /**
     * Ends an unused code before its expiry; from then on it reads as `expired`. A used, expired or unknown code, or one
     * of another organization, is `not-found`.
     */
    cancelLinkCode: defineRoute({
        method: 'POST',
        path: '/api/engines/link-codes/:linkCodeId/cancel',
        auth: 'session',
        permission: 'engine.link',
        rateLimit: null,
        input: { ...NO_INPUT, params: z.strictObject({ linkCodeId: idSchema }) },
        output: NO_CONTENT,
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
            /** Taken out of the team, but the engine refused: they can still use it until removed there. */
            refused: z.array(refusedViewSchema),
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
        input: { ...linkCodeInput, params: teamParams },
        output: linkCodeViewSchema,
        errorCodes: ['not-entitled', 'engine-limit', 'link-code-limit', 'team-has-engine'],
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
        output: z.strictObject({
            url: z.url({ protocol: /^https$/ }).max(4096),
            expiresAt: timestampSchema.nullable(),
        }),
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
    /** Queues a member revocation on the team's engine. Only an owner removes an owner (`forbidden`, 403). */
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
        // `license-limit` (403): only with `LICENSE_ENFORCEMENT` `enforce`, which no environment sets yet.
        errorCodes: ['invalid-email', 'team-not-found', 'license-limit'],
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
            /** Picks "Sign in and join" over "Join": only the link's holder learns it. */
            hasAccount: z.boolean(),
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
        output: joinedInviteSchema,
        errorCodes: ['invite-invalid', 'email-mismatch'],
    }),
    /**
     * Pending invitations to the session's verified address, offered after any sign-in or sign-up (D-33). Limited per
     * IP like the other invitation reads, though a session can only ever see its own.
     */
    listInviteOffers: defineRoute({
        method: 'GET',
        path: '/api/invites/offers',
        auth: 'session',
        permission: 'invite.accept',
        rateLimit: 'public-read-ip',
        input: NO_INPUT,
        output: z.strictObject({ offers: z.array(inviteOfferViewSchema) }),
        errorCodes: [],
    }),
    /**
     * Accepts one of `listInviteOffers` without its token. Another address's invitation, or one no longer pending, is
     * `invite-invalid` (404) alike, so IDs cannot be probed.
     */
    acceptInviteOffer: defineRoute({
        method: 'POST',
        path: '/api/invites/offers/:inviteId/accept',
        auth: 'session',
        permission: 'invite.accept',
        rateLimit: 'verify-ip',
        input: { ...NO_INPUT, params: inviteParams },
        output: joinedInviteSchema,
        errorCodes: ['invite-invalid'],
    }),
    /**
     * One-step join for an address without an account (D-31): registration options bound to the invitation.
     * `account-exists` (409) sends the page to "Sign in and join" instead.
     */
    inviteJoinOptions: defineRoute({
        method: 'POST',
        path: '/api/invites/join/options',
        auth: 'public',
        permission: null,
        rateLimit: 'options-ip',
        input: inviteTokenInput,
        output: registrationOptionsResponse,
        errorCodes: ['invite-invalid', 'account-exists'],
    }),
    /**
     * Creates the account with the invitation's address, its passkey and a session, and accepts the invitation, in one
     * transaction. The invitation link proves the address (emailed there, single use, 7 days), so no confirmation
     * email follows.
     */
    inviteJoinVerify: defineRoute({
        method: 'POST',
        path: '/api/invites/join/verify',
        auth: 'public',
        permission: null,
        rateLimit: 'verify-ip',
        input: {
            ...NO_INPUT,
            body: z.strictObject({ token: emailTokenSchema.optional(), response: registrationResponseSchema }),
            maxBodyBytes: WEBAUTHN_BODY_BYTES,
        },
        output: inviteJoinedSchema,
        errorCodes: [...ceremonyErrors, 'invite-invalid', 'account-exists'],
    }),
    /**
     * "Sign in and join": verifies an assertion made with `signinOptions`, accepts the invitation for that account and
     * signs in to the invitation's organization. `email-mismatch` (403) signs nobody in.
     */
    inviteSigninVerify: defineRoute({
        method: 'POST',
        path: '/api/invites/signin/verify',
        auth: 'public',
        permission: null,
        rateLimit: 'verify-ip',
        input: {
            ...NO_INPUT,
            body: z.strictObject({ token: emailTokenSchema.optional(), response: authenticationResponseSchema }),
            maxBodyBytes: WEBAUTHN_BODY_BYTES,
        },
        output: inviteJoinedSchema,
        errorCodes: [...ceremonyErrors, 'invite-invalid', 'email-mismatch'],
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
    // Website licensing (D-30, ADR 0021); mounted only with billing `website`.
    websiteAccessStart: defineRoute({
        method: 'GET',
        path: '/api/website-access/start',
        auth: 'public',
        permission: null,
        rateLimit: 'website-access-ip',
        input: NO_INPUT,
        output: NO_CONTENT,
        responseType: 'redirect',
        errorCodes: [],
    }),
    websiteAccessReturn: defineRoute({
        method: 'GET',
        path: '/api/website-access/return',
        auth: 'public',
        permission: null,
        rateLimit: 'website-access-ip',
        input: { ...NO_INPUT, query: websiteAccessReturnQuerySchema },
        output: NO_CONTENT,
        responseType: 'redirect',
        errorCodes: [],
    }),
    websiteAccessPending: defineRoute({
        method: 'GET',
        path: '/api/website-access/pending',
        auth: 'public',
        permission: null,
        rateLimit: 'website-access-ip',
        input: NO_INPUT,
        output: websitePendingViewSchema,
        errorCodes: [],
    }),
    websiteAccessLink: defineRoute({
        method: 'POST',
        path: '/api/website-access/link',
        auth: 'session',
        permission: 'license.link',
        rateLimit: null,
        input: NO_INPUT,
        output: z.strictObject({ linked: z.literal(true) }),
        errorCodes: ['pending-invalid', 'email-mismatch', 'website-link-conflict'],
    }),
    getLicense: defineRoute({
        method: 'GET',
        path: '/api/license',
        auth: 'session',
        permission: 'license.read',
        rateLimit: null,
        input: NO_INPUT,
        output: licenseViewSchema,
        errorCodes: [],
    }),
} as const;
