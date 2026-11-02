import { encodeBase64Url } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { Random } from '../random';

/** The relying party is the engine's own origin: passkeys made here work on this hostname and nowhere else. */
export interface RelyingParty {
    /** The hostname the browser reached (the SNI), which is also the RP ID. */
    readonly id: string;
    readonly origin: `https://${string}`;
}

export type AuthenticatorAttachment = 'platform' | 'cross-platform';

/** A WebAuthn credential as the engine keeps it: the public half only. */
export interface PasskeyCredential {
    /** Base64url, as browsers send it. */
    readonly credentialId: string;
    /** The COSE public key, base64url. */
    readonly publicKey: string;
    readonly counter: number;
    readonly transports: readonly string[];
    readonly attachment: AuthenticatorAttachment | null;
    readonly backedUp: boolean;
}

/**
 * WebAuthn's two ceremonies, with options and responses as the browser's JSON. The engine makes the challenges
 * itself (see {@link createChallenges}), so this port only builds options and verifies what comes back. Responses are
 * untrusted input: the adapter parses them strictly and answers `null` for anything that does not verify.
 */
export interface PasskeyCeremonies {
    registrationOptions(input: {
        readonly rp: RelyingParty;
        readonly rpName: string;
        /** The member's opaque WebAuthn user handle (not its member ID, which other members can see). */
        readonly userHandle: string;
        readonly userName: string;
        readonly challenge: string;
        readonly excludeCredentialIds: readonly string[];
    }): Promise<unknown>;
    verifyRegistration(input: {
        readonly rp: RelyingParty;
        readonly response: unknown;
        /** Consumes the challenge: true only for one the engine issued for this ceremony and not used yet. */
        readonly expectChallenge: (challenge: string) => boolean;
    }): Promise<PasskeyCredential | null>;
    authenticationOptions(input: {
        readonly rp: RelyingParty;
        readonly challenge: string;
        /** `null` for a usernameless sign-in: the browser offers any passkey it holds for this RP. */
        readonly allowCredentialIds: readonly string[] | null;
    }): Promise<unknown>;
    /** The credential a response claims to be from, read before verifying it, to look up its public key. */
    credentialIdOf(response: unknown): string | null;
    verifyAuthentication(input: {
        readonly rp: RelyingParty;
        readonly response: unknown;
        readonly credential: PasskeyCredential;
        readonly expectChallenge: (challenge: string) => boolean;
    }): Promise<{ readonly counter: number; readonly backedUp: boolean } | null>;
}

export const CHALLENGE_BYTES = 32;
/** Long enough for a person to find their security key, short enough that an old page cannot be replayed. */
export const CHALLENGE_LIFETIME_MS = 5 * 60_000;
/** Pending challenges are bounded, so anonymous option requests cannot grow memory without end. */
export const MAX_PENDING_CHALLENGES = 1_000;

export type CeremonyPurpose = 'setup' | 'sign-in' | 'step-up' | 'join';

export interface Challenges {
    /** A fresh challenge for `purpose`, tied to `binding` (e.g. the session a step-up is for). */
    issue(purpose: CeremonyPurpose, binding?: string): string;
    /** Single use: true once for a live challenge of that purpose and binding, false ever after. */
    take(challenge: string, purpose: CeremonyPurpose, binding?: string): boolean;
}

interface Pending {
    readonly purpose: CeremonyPurpose;
    readonly binding: string;
    readonly expiresAtMs: number;
}

export function createChallenges(deps: { readonly random: Random; readonly clock: Clock }): Challenges {
    const pending = new Map<string, Pending>();

    function sweep(nowMs: number): void {
        for (const [challenge, entry] of pending) if (entry.expiresAtMs <= nowMs) pending.delete(challenge);
        // Still full of live ones: drop the oldest, so a flood costs the flooder's own ceremonies, not memory.
        while (pending.size >= MAX_PENDING_CHALLENGES) {
            const oldest = pending.keys().next();
            if (oldest.done === true) break;
            pending.delete(oldest.value);
        }
    }

    return {
        issue(purpose, binding = '') {
            const nowMs = deps.clock.nowMs();
            sweep(nowMs);
            const challenge = encodeBase64Url(deps.random.bytes(CHALLENGE_BYTES));
            pending.set(challenge, { purpose, binding, expiresAtMs: nowMs + CHALLENGE_LIFETIME_MS });
            return challenge;
        },
        take(challenge, purpose, binding = '') {
            const entry = pending.get(challenge);
            if (entry === undefined) return false;
            pending.delete(challenge);
            return entry.purpose === purpose && entry.binding === binding && entry.expiresAtMs > deps.clock.nowMs();
        },
    };
}
