import type {
    AdminEngineView,
    BillingView,
    EngineView,
    LinkCodeView,
    PasskeyView,
    ProblemOrganization,
    SessionSummary,
    SessionView,
} from '../../shared/api/routes';
import type {
    AuthenticationOptions,
    AuthenticationResponse,
    RegistrationOptions,
    RegistrationResponse,
} from '../../shared/api/webauthn';

/** 2026-10-20T12:00:00Z, the injected "now" of every app test. */
export const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 3_600_000;

export const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456';

export function session(
    overrides: {
        readonly locale?: 'en' | 'cs';
        readonly platformRole?: 'none' | 'admin';
        readonly recoveryCooldownEndsAt?: number | null;
        readonly name?: string | null;
        readonly permissions?: readonly string[];
        readonly memberships?: SessionView['memberships'];
        readonly steppedUpUntil?: number | null;
        readonly billingEnabled?: boolean;
    } = {},
): SessionView {
    const cooldown = overrides.recoveryCooldownEndsAt ?? null;
    return {
        user: {
            id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
            email: 'ada@example.test',
            locale: overrides.locale ?? 'en',
            platformRole: overrides.platformRole ?? 'none',
            recoveredAt: cooldown === null ? null : cooldown - 72 * HOUR,
            recoveryCooldownEndsAt: cooldown,
        },
        activeOrg: {
            id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
            kind: 'personal',
            name: overrides.name === undefined ? null : overrides.name,
            role: 'owner',
            permissions: [...(overrides.permissions ?? ['org.read', 'engine.read', 'team.read'])],
        },
        memberships: overrides.memberships ?? [
            { orgId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', kind: 'personal', name: null, role: 'owner' },
        ],
        steppedUpUntil: overrides.steppedUpUntil ?? null,
        billingEnabled: overrides.billingEnabled ?? true,
    };
}

/** A test engine domain; nothing in the SPA may load from it. */
export const ENGINE_DOMAIN = 'engines.ptbk.test';
export const ENGINE_ID = 'k3v6xq2mfz4pd7h5wn2rbtcayu';

/** An active engine of another organization, as a platform admin sees it. */
export function adminEngineView(overrides: Partial<AdminEngineView> = {}): AdminEngineView {
    const engineId = (overrides.engineId ?? ENGINE_ID) as AdminEngineView['engineId'];
    return {
        engineId,
        orgId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
        hostname: `${engineId}.${ENGINE_DOMAIN}` as AdminEngineView['hostname'],
        mode: 'tunnel',
        registeredVersion: '1.4.0' as AdminEngineView['registeredVersion'],
        status: 'active',
        suspendedBy: null,
        createdAt: NOW - 48 * HOUR,
        updatedAt: NOW - 48 * HOUR,
        ...overrides,
    };
}

/** An online engine with a recent heartbeat. */
export function engineView(overrides: Partial<EngineView> = {}): EngineView {
    const engineId = (overrides.engineId ?? ENGINE_ID) as EngineView['engineId'];
    return {
        engineId,
        label: null,
        hostname: `${engineId}.${ENGINE_DOMAIN}` as EngineView['hostname'],
        customHostnames: [],
        mode: 'tunnel',
        registeredVersion: '1.4.0' as EngineView['registeredVersion'],
        status: 'online',
        suspendedBy: null,
        createdAt: NOW - 48 * HOUR,
        lastSeenAt: NOW - 30_000,
        heartbeat: {
            seq: 1_760_000_000_123,
            ts: new Date(NOW - 31_000).toISOString() as NonNullable<EngineView['heartbeat']>['ts'],
            receivedAt: NOW - 30_000,
            version: '1.4.2' as EngineView['registeredVersion'],
            uptimeS: 3 * 3600 + 25 * 60,
            diskPct: 40,
            ramPct: 70,
            cpuLoad: 'medium',
            update: 'available',
            agents: 3,
            members: 2,
        },
        // No relay presence by default, as before R-07: the reachability line stays hidden.
        reachableRelays: null,
        ...overrides,
    };
}

export const LINK_CODE = 'abcdefghijklmnopqrstuvwxya';
export const INSTALL_GUIDE_URL = 'https://docs.ptbk.test/engine/installation';

/** A freshly issued code with the three dev tabs, as the API fills them in. */
export function linkCodeView(overrides: Partial<LinkCodeView> = {}): LinkCodeView {
    return {
        linkCodeId: 'lllllllllllllllllllllllllq',
        linkCode: LINK_CODE as LinkCodeView['linkCode'],
        installCommands: [
            {
                id: 'installer',
                labelKey: 'docker-server',
                command: `bun run dev:link ${LINK_CODE}`,
                docsAnchor: '1-the-installer-recommended',
            },
            {
                id: 'compose',
                labelKey: 'docker-compose',
                command: `docker compose run --rm engine promptbook-engine connect --link ${LINK_CODE}\ndocker compose up -d`,
                docsAnchor: '2-docker-compose',
            },
            {
                id: 'connect',
                labelKey: 'already-running',
                command: `promptbook-engine connect --link ${LINK_CODE}`,
                docsAnchor: '3-link-an-engine-that-already-runs',
            },
        ],
        installGuideUrl: INSTALL_GUIDE_URL,
        expiresAt: NOW + 30 * 60_000,
        ...overrides,
    };
}

export function passkey(overrides: Partial<PasskeyView> = {}): PasskeyView {
    return {
        credentialId: 'Y3JlZGVudGlhbC1vbmUtYWJjZGVm',
        addedVia: 'signup',
        createdAt: NOW - 48 * HOUR,
        lastUsedAt: NOW - HOUR,
        backedUp: true,
        provider: 'Google Password Manager',
        counterRegressedAt: null,
        ...overrides,
    };
}

export function sessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        current: true,
        createdAt: NOW - 2 * HOUR,
        lastSeenAt: NOW - 60_000,
        expiresAt: NOW + 7 * 24 * HOUR,
        ...overrides,
    };
}

/** An org on the `none` plan that may subscribe to one plan; the owner can manage billing. */
export function billingView(overrides: Partial<BillingView> = {}): BillingView {
    return {
        status: 'none',
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        planId: 'none',
        planName: null,
        hasBillingAccount: false,
        canSubscribe: true,
        trialAvailable: true,
        entitlements: {
            features: [],
            quotas: [
                { quota: 'engines.max', limit: 0, used: null },
                { quota: 'custom-domains.max', limit: 0, used: null },
            ],
        },
        plans: [
            {
                id: 'standard',
                name: { en: 'Standard', cs: 'Standard' },
                price: { amount: '29', currency: 'EUR', interval: 'month' },
                features: ['engines.create'],
                quotas: [
                    { quota: 'engines.max', limit: null },
                    { quota: 'custom-domains.max', limit: 0 },
                ],
                trialDays: null,
            },
        ],
        ...overrides,
    };
}

export function problemOrganization(overrides: Partial<ProblemOrganization> = {}): ProblemOrganization {
    return {
        orgId: 'cccccccccccccccccccccccccc',
        kind: 'personal',
        name: null,
        status: 'past_due',
        currentPeriodEnd: NOW - 24 * HOUR,
        updatedAt: NOW - HOUR,
        ...overrides,
    };
}

export const REGISTRATION_OPTIONS: RegistrationOptions = {
    challenge: 'Y2hhbGxlbmdl',
    rp: { name: 'Promptbook', id: 'app.ptbk.test' },
    user: { id: 'dXNlcg', name: 'ada@example.test', displayName: 'ada@example.test' },
    pubKeyCredParams: [{ alg: -8, type: 'public-key' }],
    timeout: 300_000,
    attestation: 'none',
    excludeCredentials: [],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    extensions: { credProps: true },
    hints: [],
};

export const AUTHENTICATION_OPTIONS: AuthenticationOptions = {
    challenge: 'Y2hhbGxlbmdl',
    timeout: 300_000,
    rpId: 'app.ptbk.test',
    allowCredentials: [],
    userVerification: 'required',
};

export const REGISTRATION_RESPONSE: RegistrationResponse = {
    id: 'Y3JlZA',
    rawId: 'Y3JlZA',
    type: 'public-key',
    response: { clientDataJSON: 'Y2xpZW50', attestationObject: 'YXR0' },
    clientExtensionResults: {},
};

export const AUTHENTICATION_RESPONSE: AuthenticationResponse = {
    id: 'Y3JlZA',
    rawId: 'Y3JlZA',
    type: 'public-key',
    response: { clientDataJSON: 'Y2xpZW50', authenticatorData: 'YXV0aA', signature: 'c2ln', userHandle: 'dXNlcg' },
    clientExtensionResults: {},
};
