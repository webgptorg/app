import { encodeBase64Url } from '@ptbk/protocol';

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

export interface SetupSecrets {
    /** A fresh secret that replaces any earlier one, so an old copy of the link stops working. */
    issue(): Promise<IssuedSetupSecret>;
    /** Whether `candidate` would set up the owner now; spends nothing. */
    check(candidate: string): Promise<SetupSecretCheck>;
    /** Checks and spends the secret in one step: of two setups racing with the same link, only one is `valid`. */
    consume(candidate: string): Promise<SetupSecretCheck>;
    /** Drops the stored secret, if any. */
    revoke(): Promise<void>;
}

export interface SetupSecretDeps {
    readonly store: SetupSecretStore;
    readonly random: Random;
    readonly clock: Clock;
    /** Read on every call: once the owner has a passkey, no secret works, stored or not. */
    readonly hasOwner: () => boolean;
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

    async function verdict(candidate: string): Promise<SetupSecretCheck> {
        if (deps.hasOwner()) return 'owner-exists';
        const stored = await deps.store.load();
        // Hashed even when nothing could match, so a malformed or absent secret takes the same work as a wrong one.
        const digest = await sha256Hex(candidate);
        if (stored === null || !SETUP_SECRET_PATTERN.test(candidate)) return 'invalid';
        if (deps.clock.nowMs() >= stored.expiresAtMs) return 'invalid';
        return sameDigest(digest, stored.sha256) ? 'valid' : 'invalid';
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
        check: (candidate) => serially(() => verdict(candidate)),
        consume: (candidate) =>
            serially(async () => {
                const result = await verdict(candidate);
                if (result === 'valid') await deps.store.clear();
                return result;
            }),
        revoke: () => serially(() => deps.store.clear()),
    };
}
