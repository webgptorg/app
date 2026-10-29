import type {
    AuthenticationOptions,
    AuthenticationResponse,
    AuthenticatorTransport,
    RegistrationOptions,
    RegistrationResponse,
} from '../../shared/api/webauthn';

export interface CredentialDescriptor {
    readonly id: string;
    readonly transports: readonly AuthenticatorTransport[];
}

export interface VerifiedCredential {
    /** base64url, as the browser reports it. */
    readonly id: string;
    readonly publicKey: Uint8Array;
    readonly counter: number;
    readonly transports: readonly AuthenticatorTransport[];
    readonly backedUp: boolean;
    /** The authenticator model, normalized: lowercase, null for none or the all-zero one. */
    readonly aaguid: string | null;
}

/**
 * The WebAuthn relying party for the dashboard's own origin: rpID and expected origin are fixed by the adapter from
 * config. Verification always requires user verification.
 */
export interface RelyingParty {
    registrationOptions(input: {
        readonly challenge: string;
        readonly userHandle: Uint8Array;
        readonly userName: string;
        readonly exclude: readonly CredentialDescriptor[];
    }): Promise<RegistrationOptions>;
    authenticationOptions(input: {
        readonly challenge: string;
        readonly allow: readonly CredentialDescriptor[];
    }): AuthenticationOptions;
    verifyRegistration(input: {
        readonly response: RegistrationResponse;
        readonly expectedChallenge: string;
    }): Promise<{ readonly kind: 'verified'; readonly credential: VerifiedCredential } | { readonly kind: 'rejected' }>;
    /**
     * Checks signature, challenge, origin, rpID and user verification. The signature counter is returned, not judged:
     * the caller compares it with the stored one so a regression can be recorded.
     */
    verifyAuthentication(input: {
        readonly response: AuthenticationResponse;
        readonly expectedChallenge: string;
        readonly credential: { readonly id: string; readonly publicKey: Uint8Array };
    }): Promise<{ readonly kind: 'verified'; readonly newCounter: number } | { readonly kind: 'rejected' }>;
}
