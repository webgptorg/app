import type { OwnerSetupCommitment } from '@ptbk/protocol';
import { OWNER_HANDOFF_LIFETIME_MS, encodeBase64Url, ownerSetupCommitmentDigest } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { Random } from '../random';
import type { Secret } from '../secret';
import { secret } from '../secret';

/** 128 bits: guessing is hopeless even without the rate limit on `/setup`. */
export const SETUP_SECRET_BYTES = 16;
export const SETUP_SECRET_LIFETIME_MS = 30 * 60_000;
/** Base64url of {@link SETUP_SECRET_BYTES} bytes, without padding. */
export const SETUP_SECRET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** All that is kept of a setup secret: its SHA-256 and when it ends. The secret itself is never written down. */
export interface StoredSetupSecret {
    /** Lowercase hex. */
    readonly sha256: string;
    readonly expiresAtMs: number;
}

export interface SetupSecretStore {
    load(): Promise<StoredSetupSecret | null>;
    save(secret: StoredSetupSecret): Promise<void>;
    clear(): Promise<void>;
}

/** For engines whose secret need not survive a restart (tests); the engine itself keeps it in `PTBK_DATA_DIR`. */
export function createInMemorySetupSecretStore(): SetupSecretStore & {
    readonly current: () => StoredSetupSecret | null;
} {
    let stored: StoredSetupSecret | null = null;
    return {
        load: () => Promise.resolve(stored),
        save(next) {
            stored = next;
            return Promise.resolve();
        },
        clear() {
            stored = null;
            return Promise.resolve();
        },
        current: () => stored,
    };
}

export type IssuedSetupSecret =
    | { readonly kind: 'issued'; readonly secret: Secret; readonly expiresAtMs: number }
    | { readonly kind: 'owner-exists' };

/**
 * `invalid` covers a wrong, an expired and a spent secret alike, so the answer tells a guesser nothing. That the engine
 * has an owner is public (its sign-in page says so), so it gets its own answer.
 */
export type SetupSecretCheck = 'valid' | 'invalid' | 'owner-exists';

/** Which slot a setup secret matched: the engine's own link, or the pairing tab's handoff (ADR 0023). */
export type SetupSlot = 'setup-link' | 'owner-handoff';

export type SpentSetupSecret =
    | { readonly kind: 'valid'; readonly slot: SetupSlot }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'owner-exists' };

export type HandoffAcceptance = 'accepted' | 'owner-exists' | 'off';

export interface SetupSecrets {
    /** A fresh secret that replaces any earlier one, so an old copy of the link stops working. */
    issue(): Promise<IssuedSetupSecret>;
    /** Whether `candidate` would set up the owner now; spends nothing. */
    check(candidate: string): Promise<SetupSecretCheck>;
    /**
     * Checks and spends the secret in one step: of two setups racing with the same link, only one is `valid`. A valid
     * secret from either slot spends both, so the owner seat is claimed once.
     */
    consume(candidate: string): Promise<SpentSetupSecret>;
    /** Drops both slots, for `owner --reset`: a reset must never revive the pairing tab's secret. */
    revoke(): Promise<void>;
    /**
     * Keeps the registration answer's commitment as the handoff slot for `OWNER_HANDOFF_LIFETIME_MS` from
     * `registeredAtMs`; ignored with an owner or with handoff off.
     */
    acceptHandoff(commitment: OwnerSetupCommitment, registeredAtMs: number): Promise<HandoffAcceptance>;
    /** Reads a slot another process (`connect`) stored; drops it if the engine already has an owner. */
    loadHandoff(): Promise<void>;
    /** Whether the handoff slot could set up the owner now; synchronous, for each heartbeat. */
    handoffLive(): boolean;
}

export interface SetupSecretDeps {
    readonly store: SetupSecretStore;
    readonly random: Random;
    readonly clock: Clock;
    /** Read on every call: once the owner has a passkey, no secret works, stored or not. */
    readonly hasOwner: () => boolean;
    /** The handoff slot's store; without it the handoff is off and every commitment is ignored. */
    readonly handoff?: SetupSecretStore;
}

/** The slot a pairing tab's commitment becomes: the same hex SHA-256 the engine keeps of its own secret. */
export function handoffSlot(commitment: OwnerSetupCommitment, registeredAtMs: number): StoredSetupSecret {
    const digest = ownerSetupCommitmentDigest(commitment);
    return {
        sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        expiresAtMs: registeredAtMs + OWNER_HANDOFF_LIFETIME_MS,
    };
}

async function sha256Hex(text: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant time for equal lengths (digests always are), so the comparison leaks no prefix of the stored digest. */
function sameDigest(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    return difference === 0;
}

/**
 * The one-time setup secret (installation.md, "The setup link"): 128 bits from the crypto `Random`, base64url, valid
 * once and for 30 minutes, and stored only as its SHA-256. Calls run one at a time, so a check and the write that
 * spends or replaces the secret can never interleave with another.
 */
export function createSetupSecrets(deps: SetupSecretDeps): SetupSecrets {
    let queue: Promise<unknown> = Promise.resolve();
    const serially = <T>(task: () => Promise<T>): Promise<T> => {
        const result = queue.then(task, task);
        queue = result.catch(() => undefined);
        return result;
    };

    let handoff: StoredSetupSecret | null = null;
    const live = (slot: StoredSetupSecret | null): slot is StoredSetupSecret =>
        slot !== null && deps.clock.nowMs() < slot.expiresAtMs;

    async function verdict(candidate: string): Promise<SpentSetupSecret> {
        if (deps.hasOwner()) return { kind: 'owner-exists' };
        const own = await deps.store.load();
        // Hashed and compared with both slots even when nothing could match, so every miss takes the same work.
        const digest = await sha256Hex(candidate);
        const matchesOwn = live(own) && sameDigest(digest, own.sha256);
        const matchesHandoff = live(handoff) && sameDigest(digest, handoff.sha256);
        if (!SETUP_SECRET_PATTERN.test(candidate)) return { kind: 'invalid' };
        if (matchesOwn) return { kind: 'valid', slot: 'setup-link' };
        if (matchesHandoff) return { kind: 'valid', slot: 'owner-handoff' };
        return { kind: 'invalid' };
    }

    async function dropHandoff(): Promise<void> {
        handoff = null;
        await deps.handoff?.clear();
    }

    return {
        issue: () =>
            serially(async () => {
                if (deps.hasOwner()) return { kind: 'owner-exists' } as const;
                const value = encodeBase64Url(deps.random.bytes(SETUP_SECRET_BYTES));
                const expiresAtMs = deps.clock.nowMs() + SETUP_SECRET_LIFETIME_MS;
                await deps.store.save({ sha256: await sha256Hex(value), expiresAtMs });
                return { kind: 'issued', secret: secret(value), expiresAtMs } as const;
            }),
        check: (candidate) => serially(async () => (await verdict(candidate)).kind),
        consume: (candidate) =>
            serially(async () => {
                const result = await verdict(candidate);
                if (result.kind === 'valid') {
                    await deps.store.clear();
                    await dropHandoff();
                }
                return result;
            }),
        revoke: () =>
            serially(async () => {
                await deps.store.clear();
                await dropHandoff();
            }),
        acceptHandoff: (commitment, registeredAtMs) =>
            serially(async () => {
                if (deps.handoff === undefined) return 'off';
                if (deps.hasOwner()) return 'owner-exists';
                handoff = handoffSlot(commitment, registeredAtMs);
                await deps.handoff.save(handoff);
                return 'accepted';
            }),
        loadHandoff: () =>
            serially(async () => {
                if (deps.handoff === undefined) return;
                if (deps.hasOwner()) {
                    await dropHandoff();
                    return;
                }
                handoff = await deps.handoff.load();
            }),
        handoffLive: () => deps.handoff !== undefined && !deps.hasOwner() && live(handoff),
    };
}
