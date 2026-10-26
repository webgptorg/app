import type { Bytes, TunnelAuth, TunnelChallenge } from '@ptbk/protocol';
import {
    EngineVersion,
    SIGNING_CONTEXT,
    TUNNEL_CLOSE_CODE,
    decodeBase64Url,
    ed25519SignatureToBytes,
    signingInput,
    verifyEd25519,
    verifyTunnelAuth,
} from '@ptbk/protocol';

import { Findings, PASS, fail } from '../../../src/check';
import type { RelayConnection } from '../../fake-relay/fake-relay';
import type { ChallengeOverrides } from '../handshake';
import { awaitAuth, judgeAuth, sendChallenge } from '../handshake';
import type { TunnelCheckContext, TunnelCheckRun } from './support';
import { closeWithin, collect, engineKey, nextConnection } from './support';

/** Unsorted on purpose: numeric order differs from string order, and byte order from locale order. */
const UNSORTED_VERSIONS = [10, 2, 1];
const UNSORTED_FEATURES = ['zz-top', 'ab', 'a-b', '9x', '10x'];

interface Answered {
    readonly connection: RelayConnection;
    readonly challenge: TunnelChallenge;
    readonly auth: TunnelAuth;
    readonly authMs: number;
}

/** A fresh connection to the primary relay, challenged with `overrides`; fails the check unless `auth` comes back. */
async function challenged(
    ctx: TunnelCheckContext,
    next: (timeoutMs: number) => Promise<RelayConnection | null>,
    overrides: ChallengeOverrides = {},
): Promise<Answered> {
    const { timing } = ctx.runtime;
    const connection = await nextConnection(next, timing.reconnectMs, 'for a new challenge');
    const sentAt = performance.now();
    const challenge = sendChallenge(connection, overrides);
    const answer = await awaitAuth(connection, timing.authMs, ctx.signal);
    switch (answer.kind) {
        case 'timeout':
            fail(`no auth within AUTH_TIMEOUT_MS (${String(timing.authMs)} ms) of the challenge`);
            break;
        case 'closed':
            fail(`the engine closed with ${String(answer.code)} instead of answering the challenge`);
            break;
        case 'invalid':
            fail(`the engine answered the challenge with ${answer.what}`);
            break;
        case 'auth':
            return { connection, challenge, auth: answer.auth, authMs: answer.at - sentAt };
    }
}

/** Joins a list the way the contract does not, to tell an engine which encoding its signature used instead. */
function signedOver(
    key: Bytes,
    challenge: TunnelChallenge,
    auth: TunnelAuth,
    encode: (list: readonly (number | string)[]) => string,
    version: string | null = auth.version,
): boolean {
    const nonce = decodeBase64Url(challenge.nonce);
    if (nonce.kind === 'invalid') return false;
    const parts = [
        challenge.relayId,
        nonce.bytes,
        auth.engineId,
        ...(version === null ? [] : [version]),
        encode(challenge.protocolVersions),
        encode(challenge.features),
        encode(auth.protocolVersions),
        encode(auth.features),
    ];
    return verifyEd25519(key, signingInput(SIGNING_CONTEXT.tunnel, ...parts), ed25519SignatureToBytes(auth.sig));
}

const LIST_ENCODINGS: readonly {
    readonly name: string;
    readonly encode: (list: readonly (number | string)[]) => string;
}[] = [
    { name: 'in the order received', encode: (list) => list.join(',') },
    { name: 'sorted as strings', encode: (list) => list.map(String).sort().join(',') },
    {
        name: 'sorted by locale',
        encode: (list) =>
            list
                .map(String)
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                .join(','),
    },
];

function canonical(list: readonly (number | string)[]): string {
    return typeof list[0] === 'number'
        ? [...(list as number[])].sort((a, b) => a - b).join(',')
        : [...(list as string[])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',');
}

export const signatureVerifies: TunnelCheckRun = async (ctx) => {
    const key = engineKey(ctx);
    const { runtime } = ctx;
    return runtime.manual(runtime.primary, ctx.signal, async (next) => {
        const { connection, challenge, auth } = await challenged(ctx, next);
        const verdict = await judgeAuth(key, challenge, auth);
        const findings = new Findings();
        if (verdict.kind === 'wrong-engine-id')
            findings.add("auth names an engineId not derived from the engine's key");
        if (verdict.kind === 'bad-signature') findings.add('the auth signature does not verify with verifyTunnelAuth');
        if (findings.count > 0) return findings.outcome();
        if (runtime.complete(connection, challenge, auth) === null) {
            findings.add('auth offers no protocol version this relay speaks (v1)');
        }
        return findings.outcome();
    });
};

export const freshNonce: TunnelCheckRun = async (ctx) => {
    const key = engineKey(ctx);
    const { runtime } = ctx;
    return runtime.manual(runtime.primary, ctx.signal, async (next) => {
        const first = await challenged(ctx, next);
        const tunnel = runtime.complete(first.connection, first.challenge, first.auth);
        if (tunnel === null) fail('auth offers no protocol version this relay speaks (v1)');
        tunnel.close(TUNNEL_CLOSE_CODE.SHUTTING_DOWN);
        const second = await challenged(ctx, next);
        const findings = new Findings();
        if (!verifyTunnelAuth(key, first.challenge, first.auth)) findings.add('the first auth does not verify');
        if (!verifyTunnelAuth(key, second.challenge, second.auth)) {
            findings.add(
                verifyTunnelAuth(key, first.challenge, second.auth)
                    ? "the second connection's auth signs the first connection's nonce"
                    : "the second connection's auth does not verify against its own challenge",
            );
        }
        runtime.complete(second.connection, second.challenge, second.auth);
        return findings.outcome();
    });
};

export const versionSigned: TunnelCheckRun = async (ctx) => {
    const key = engineKey(ctx);
    const { runtime } = ctx;
    return runtime.manual(runtime.primary, ctx.signal, async (next) => {
        const { connection, challenge, auth } = await challenged(ctx, next);
        runtime.complete(connection, challenge, auth);
        if (!verifyTunnelAuth(key, challenge, auth)) {
            if (signedOver(key, challenge, auth, canonical, null)) {
                fail('the auth signature leaves version out of ptbk-tunnel-v1');
            }
            fail('the auth signature does not verify over the version the engine sent');
        }
        const other = EngineVersion.parse(auth.version === '0.0.0' ? '0.0.1' : '0.0.0');
        if (verifyTunnelAuth(key, challenge, { ...auth, version: other })) {
            fail('the same signature also verifies with another version');
        }
        return PASS;
    });
};

export const listEncoding: TunnelCheckRun = async (ctx) => {
    const key = engineKey(ctx);
    const { runtime } = ctx;
    return runtime.manual(runtime.primary, ctx.signal, async (next) => {
        const { connection, challenge, auth } = await challenged(ctx, next, {
            protocolVersions: UNSORTED_VERSIONS,
            features: UNSORTED_FEATURES,
        });
        if (verifyTunnelAuth(key, challenge, auth)) {
            const tunnel = runtime.complete(connection, challenge, auth);
            if (tunnel === null) fail('auth offers no protocol version this relay speaks (v1)');
            // The engine must also accept the ready that follows from these lists.
            const closed = await closeWithin(connection, runtime.timing.quietMs);
            if (closed.kind === 'closed') {
                fail(`the engine closed with ${String(closed.code)} after an honest ready for unsorted lists`);
            }
            return PASS;
        }
        const used = LIST_ENCODINGS.find(({ encode }) => signedOver(key, challenge, auth, encode));
        fail(
            used === undefined
                ? 'the auth signature does not verify for a challenge with unsorted lists'
                : `the auth signature encodes the lists ${used.name}, not numerically and by byte`,
        );
    });
};

export const wrongRelayRefused: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const [, other] = runtime.relayIds;
    // A relay forwarding another relay's challenge, or one naming a relay the engine never dialled.
    const claimed = other ?? `elsewhere.${runtime.primary}`;
    return runtime.manual(runtime.primary, ctx.signal, async (next) => {
        const connection = await nextConnection(next, runtime.timing.reconnectMs, 'for a new challenge');
        sendChallenge(connection, { relayId: claimed });
        const events = await collect(connection, runtime.timing.observeMs + runtime.timing.closeMs, ctx.signal);
        runtime.disrupted();
        if (events.some((event) => event.kind === 'text')) fail('the engine answered a challenge naming another relay');
        if (!events.some((event) => event.kind === 'closed')) {
            fail('the engine neither answered nor closed after a challenge naming another relay');
        }
        return PASS;
    });
};
