import type { PasskeyView, SessionSummary, SessionView } from '../../shared/api/routes';
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
            permissions: [...(overrides.permissions ?? ['org.read'])],
        },
        memberships: [{ orgId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', kind: 'personal', name: null, role: 'owner' }],
        steppedUpUntil: null,
    };
}

export function passkey(overrides: Partial<PasskeyView> = {}): PasskeyView {
    return {
        credentialId: 'Y3JlZGVudGlhbC1vbmUtYWJjZGVm',
        addedVia: 'signup',
        createdAt: NOW - 48 * HOUR,
        lastUsedAt: NOW - HOUR,
        backedUp: true,
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
