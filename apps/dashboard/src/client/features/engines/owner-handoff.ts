import {
    createCryptoRandom,
    Hostname,
    newOwnerSetupSecret,
    ownerSetupCommitment,
    OwnerSetupSecret,
    type OwnerSetupCommitment,
    type Random,
} from '@ptbk/protocol';

import type { EngineView, LinkCodeStatusView } from '../../../shared/api/routes';
import { reportsLive } from './engine-order';

/**
 * The tab's `sessionStorage`: the owner setup secret (ADR 0023) must not outlive the tab or reach another one, so never
 * `localStorage`, the URL, the query cache or a request.
 */
export type OwnerSetupStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KEY_PREFIX = 'ptbk.ownerSetup.';

function keyOf(linkCodeId: string): string {
    return `${KEY_PREFIX}${linkCodeId}`;
}

export interface DrawnOwnerSetup {
    readonly secret: OwnerSetupSecret;
    /** All the dashboard ever receives: `SHA-256` of the secret, which hides 128 random bits. */
    readonly commitment: OwnerSetupCommitment;
}

export async function drawOwnerSetup(random: Random = createCryptoRandom()): Promise<DrawnOwnerSetup> {
    const secret = newOwnerSetupSecret(random);
    return { secret, commitment: await ownerSetupCommitment(secret) };
}

/**
 * Keeps the secret under the code it was sent with, and drops the one of the code it replaces in this tab. False when
 * the browser refuses storage: then no redirect can happen, and the caller should not have sent the commitment.
 */
export function keepOwnerSetupSecret(
    storage: OwnerSetupStorage,
    linkCodeId: string,
    secret: OwnerSetupSecret,
    replaces: string | undefined,
): boolean {
    try {
        if (replaces !== undefined && replaces !== linkCodeId) storage.removeItem(keyOf(replaces));
        storage.setItem(keyOf(linkCodeId), secret);
        return true;
    } catch {
        return false;
    }
}

/** Whether the browser lets this tab keep a secret at all; probed before a commitment is sent. */
export function canKeepOwnerSetupSecret(storage: OwnerSetupStorage | undefined): storage is OwnerSetupStorage {
    if (storage === undefined) return false;
    const probe = `${KEY_PREFIX}probe`;
    try {
        storage.setItem(probe, '1');
        storage.removeItem(probe);
        return true;
    } catch {
        return false;
    }
}

function storedSecret(storage: OwnerSetupStorage | undefined, linkCodeId: string): OwnerSetupSecret | null {
    try {
        return OwnerSetupSecret.safeParse(storage?.getItem(keyOf(linkCodeId))).data ?? null;
    } catch {
        return null;
    }
}

export function holdsOwnerSetupSecret(storage: OwnerSetupStorage | undefined, linkCodeId: string): boolean {
    return storedSecret(storage, linkCodeId) !== null;
}

/**
 * Where to send the owner, once everything ADR 0023 waits for holds: the code linked, the engine reporting live with
 * no member and `ownerHandoff: ready`, and, for a tunnel engine, a relay holding its tunnel. Relays never carry a direct
 * engine, so for it the engine's own signal, which it sends only once its address serves browsers, is all there is.
 */
export function ownerHandoffHostname(
    code: LinkCodeStatusView | undefined,
    engine: EngineView | undefined,
): Hostname | null {
    if (code?.status !== 'linked' || engine === undefined || engine.engineId !== code.engineId) return null;
    const heartbeat = engine.heartbeat;
    if (heartbeat === null || heartbeat.members !== 0 || heartbeat.ownerHandoff !== 'ready') return null;
    if (!reportsLive(engine)) return null;
    if (engine.mode === 'tunnel' && !((engine.reachableRelays ?? 0) > 0)) return null;
    return Hostname.safeParse(engine.hostname).data ?? null;
}

export interface OwnerHandoffDeps {
    readonly storage: OwnerSetupStorage | undefined;
    readonly navigate: (url: string) => void;
}

/**
 * Sends this tab to the engine's setup page with the secret in the fragment, which never reaches a server. The secret
 * is deleted before navigating, and nothing navigates if it cannot be, so each secret leads to at most one redirect.
 */
export function handOffOwnerSetup(
    deps: OwnerHandoffDeps,
    linkCodeId: string,
    code: LinkCodeStatusView | undefined,
    engine: EngineView | undefined,
): boolean {
    const hostname = ownerHandoffHostname(code, engine);
    const secret = hostname === null ? null : storedSecret(deps.storage, linkCodeId);
    if (hostname === null || secret === null || deps.storage === undefined) return false;
    try {
        deps.storage.removeItem(keyOf(linkCodeId));
    } catch {
        return false;
    }
    deps.navigate(`https://${hostname}/setup#${secret}`);
    return true;
}
