import type { Bytes, Hostname, TunnelAuth, TunnelChallenge, TunnelFeature, TunnelReady } from '@ptbk/protocol';
import {
    NONCE_BYTES,
    TUNNEL_CLOSE_CODE,
    TUNNEL_FEATURES,
    TUNNEL_PROTOCOL_VERSIONS,
    TunnelChallenge as TunnelChallengeSchema,
    defaultHostname,
    deriveEngineId,
    encodeBase64Url,
    negotiateTunnel,
    parseEngineMessage,
    verifyTunnelAuth,
} from '@ptbk/protocol';

import { TIMED_OUT } from '../fake-relay/event-queue';
import type { RelayConnection } from '../fake-relay/fake-relay';
import { RelayTunnel } from '../fake-relay/relay-tunnel';

export interface ChallengeOverrides {
    readonly relayId?: string;
    readonly protocolVersions?: readonly number[];
    readonly features?: readonly string[];
}

/** A fresh challenge for `connection`, with a new random nonce every time. */
export function buildChallenge(connection: RelayConnection, overrides: ChallengeOverrides = {}): TunnelChallenge {
    return TunnelChallengeSchema.parse({
        v: 1,
        type: 'challenge',
        nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))),
        relayId: overrides.relayId ?? connection.relayId,
        protocolVersions: [...(overrides.protocolVersions ?? TUNNEL_PROTOCOL_VERSIONS)],
        features: [...(overrides.features ?? TUNNEL_FEATURES)],
    });
}

/** Sends a fresh challenge and returns exactly what was sent. */
export function sendChallenge(connection: RelayConnection, overrides: ChallengeOverrides = {}): TunnelChallenge {
    const challenge = buildChallenge(connection, overrides);
    connection.sendJson(challenge);
    return challenge;
}

export type AuthWait =
    | { readonly kind: 'auth'; readonly auth: TunnelAuth; readonly text: string; readonly at: number }
    | { readonly kind: 'invalid'; readonly what: string }
    | { readonly kind: 'closed'; readonly code: number }
    | { readonly kind: 'timeout' };

/** The engine's answer to a challenge: the first message it sends, which must be a strict `auth`. */
export async function awaitAuth(
    connection: RelayConnection,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<AuthWait> {
    const event = await connection.events.next(timeoutMs, signal);
    if (event === TIMED_OUT) return { kind: 'timeout' };
    switch (event.kind) {
        case 'closed':
            return { kind: 'closed', code: event.code };
        case 'binary':
            return { kind: 'invalid', what: 'a binary message instead of auth' };
        case 'text': {
            const parsed = parseEngineMessage(event.text);
            return parsed.kind === 'ok'
                ? { kind: 'auth', auth: parsed.message, text: event.text, at: event.at }
                : { kind: 'invalid', what: 'a text message that is not a strict auth' };
        }
    }
}

/** The `ready` an honest relay answers: `negotiateTunnel` over both signed lists, the default hostname. */
export function honestReady(challenge: TunnelChallenge, auth: TunnelAuth, engineDomain: Hostname): TunnelReady | null {
    const negotiated = negotiateTunnel(
        { versions: challenge.protocolVersions, features: challenge.features },
        { versions: auth.protocolVersions, features: auth.features },
    );
    if (negotiated.kind === 'unsupported-version') return null;
    return {
        v: 1,
        type: 'ready',
        protocolVersion: negotiated.protocolVersion,
        features: [...negotiated.features] as TunnelFeature[],
        hostnames: [defaultHostname(auth.engineId, engineDomain)],
    };
}

export type AuthVerdict =
    { readonly kind: 'verified' } | { readonly kind: 'wrong-engine-id' } | { readonly kind: 'bad-signature' };

/** What R-03 decides: the engine ID must be the key's, and the signature must verify against the challenge sent. */
export async function judgeAuth(engineKey: Bytes, challenge: TunnelChallenge, auth: TunnelAuth): Promise<AuthVerdict> {
    if ((await deriveEngineId(engineKey)) !== auth.engineId) return { kind: 'wrong-engine-id' };
    return verifyTunnelAuth(engineKey, challenge, auth) ? { kind: 'verified' } : { kind: 'bad-signature' };
}

export interface AcceptOptions {
    /** The key from the engine's registration. */
    readonly engineKey: Bytes;
    readonly engineDomain: Hostname;
    readonly authTimeoutMs: number;
    readonly signal: AbortSignal;
    readonly challenge?: ChallengeOverrides;
}

export type Accepted =
    { readonly kind: 'ready'; readonly tunnel: RelayTunnel } | { readonly kind: 'failed'; readonly reason: string };

/** The whole handshake as an honest relay runs it; refuses an `auth` that does not verify, as R-03 does. */
export async function acceptConnection(connection: RelayConnection, options: AcceptOptions): Promise<Accepted> {
    const challenge = sendChallenge(connection, options.challenge);
    const answer = await awaitAuth(connection, options.authTimeoutMs, options.signal);
    switch (answer.kind) {
        case 'timeout':
            connection.sendJson({ v: 1, type: 'reject', reason: 'timeout' });
            connection.close(TUNNEL_CLOSE_CODE.AUTH_FAILED);
            return { kind: 'failed', reason: 'no auth in time' };
        case 'closed':
            return { kind: 'failed', reason: `closed with ${String(answer.code)} before auth` };
        case 'invalid':
            connection.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            return { kind: 'failed', reason: answer.what };
        case 'auth':
            break;
    }
    const verdict = await judgeAuth(options.engineKey, challenge, answer.auth);
    if (verdict.kind !== 'verified') {
        connection.sendJson({ v: 1, type: 'reject', reason: 'auth-failed' });
        connection.close(TUNNEL_CLOSE_CODE.AUTH_FAILED);
        return { kind: 'failed', reason: verdict.kind };
    }
    const ready = honestReady(challenge, answer.auth, options.engineDomain);
    if (ready === null) {
        connection.sendJson({ v: 1, type: 'reject', reason: 'unsupported-version' });
        connection.close(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
        return { kind: 'failed', reason: 'no common protocol version' };
    }
    const tunnel = new RelayTunnel(connection, { challenge, auth: answer.auth, ready });
    connection.sendJson(ready);
    return { kind: 'ready', tunnel };
}
