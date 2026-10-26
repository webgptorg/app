import type { TunnelAuth } from '@ptbk/protocol';
import {
    FrameType,
    StreamId,
    TUNNEL_CLOSE_CODE,
    TUNNEL_PROTOCOL_VERSIONS,
    defaultHostname,
    encodeFrame,
} from '@ptbk/protocol';

import { Findings, fail } from '../../../src/check';
import type { RelayConnection } from '../../fake-relay/fake-relay';
import { awaitAuth, buildChallenge, sendChallenge } from '../handshake';
import type { ChallengeOverrides } from '../handshake';
import type { TunnelCheckContext, TunnelCheckRun } from './support';
import { closeWithin, collect, nextConnection, readyTunnel } from './support';

const EXTRA_FEATURE = 'conformance-extra';

/** Byte order, as C-02 sorts features; features are ASCII, where code-unit order is byte order. */
function compareFeatures(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

interface DowngradeVariant {
    readonly name: string;
    readonly challenge: ChallengeOverrides;
    /** The relay's (dishonest) choice. */
    readonly protocolVersion: number;
    readonly features: readonly string[];
}

/**
 * What a party in the path could try, given what the engine offers. A v1 engine offers one version, so no lower
 * common version exists; the version variant then offers one the engine never listed, which `checkTunnelReady`
 * refuses for the same reason (the choice is not `negotiateTunnel` over the signed lists).
 */
function downgradeVariants(offer: TunnelAuth): DowngradeVariant[] {
    const versions = [...offer.protocolVersions].sort((a, b) => a - b);
    const features = [...offer.features].sort(compareFeatures);
    const variants: DowngradeVariant[] = [];
    const highest = versions.at(-1) ?? 1;
    const [lowest = 1] = versions;
    if (versions.length > 1) {
        variants.push({
            name: 'a lower common version',
            challenge: { protocolVersions: versions, features },
            protocolVersion: lowest,
            features,
        });
    } else {
        const unoffered = highest + 1;
        variants.push({
            name: 'a version the engine did not offer',
            challenge: { protocolVersions: [highest, unoffered], features },
            protocolVersion: unoffered,
            features,
        });
    }
    variants.push({
        name: 'an extra feature',
        challenge: { protocolVersions: versions, features: [...features, EXTRA_FEATURE] },
        protocolVersion: highest,
        features: [...features, EXTRA_FEATURE].sort(compareFeatures),
    });
    // A missing feature needs a feature both sides know; a v1 engine offers none, so the variant needs a later one.
    const [dropped] = features;
    if (dropped !== undefined) {
        variants.push({
            name: 'a missing feature',
            challenge: { protocolVersions: versions, features },
            protocolVersion: highest,
            features: features.filter((feature) => feature !== dropped),
        });
    }
    return variants;
}

async function expectProtocolError(
    ctx: TunnelCheckContext,
    connection: RelayConnection,
    findings: Findings,
    what: string,
): Promise<void> {
    const closed = await closeWithin(connection, ctx.runtime.timing.closeMs);
    if (closed.kind === 'open') findings.add(`${what}: the engine kept the tunnel open`);
    else if (closed.code !== TUNNEL_CLOSE_CODE.PROTOCOL_ERROR) {
        findings.add(`${what}: the engine closed with ${String(closed.code)}, not PROTOCOL_ERROR`);
    }
}

async function answeredAuth(ctx: TunnelCheckContext, connection: RelayConnection): Promise<TunnelAuth> {
    const answer = await awaitAuth(connection, ctx.runtime.timing.authMs, ctx.signal);
    if (answer.kind !== 'auth') fail('the engine did not answer a valid challenge with auth');
    return answer.auth;
}

export const downgradeRefused: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const offer = (await readyTunnel(ctx)).auth;
    const variants = downgradeVariants(offer);
    const findings = new Findings();
    await runtime.manual(runtime.primary, ctx.signal, async (next) => {
        for (const variant of variants) {
            const connection = await nextConnection(next, runtime.timing.reconnectMs, 'after the previous variant');
            sendChallenge(connection, variant.challenge);
            const auth = await answeredAuth(ctx, connection);
            connection.sendJson({
                v: 1,
                type: 'ready',
                protocolVersion: variant.protocolVersion,
                features: variant.features,
                hostnames: [defaultHostname(auth.engineId, runtime.engineDomain)],
            });
            await expectProtocolError(ctx, connection, findings, `a ready with ${variant.name}`);
        }
    });
    return findings.outcome();
};

export const invalidMessageRefused: TunnelCheckRun = async (ctx) => {
    const { runtime } = ctx;
    const findings = new Findings();
    await runtime.manual(runtime.primary, ctx.signal, async (next) => {
        const wait = (): Promise<RelayConnection> =>
            nextConnection(next, runtime.timing.reconnectMs, 'after the previous variant');

        const unknownField = await wait();
        unknownField.sendJson({ ...buildChallenge(unknownField), conformance: true });
        const events = await collect(unknownField, runtime.timing.closeMs, ctx.signal);
        const closed = events.find((event) => event.kind === 'closed');
        if (events.some((event) => event.kind === 'text'))
            findings.add('a challenge with an unknown field got an answer');
        if (closed === undefined) findings.add('a challenge with an unknown field: the engine kept the tunnel open');
        else if (closed.code !== TUNNEL_CLOSE_CODE.PROTOCOL_ERROR) {
            findings.add(`a challenge with an unknown field: closed with ${String(closed.code)}, not PROTOCOL_ERROR`);
        }

        const readyFirst = await wait();
        readyFirst.sendJson({
            v: 1,
            type: 'ready',
            protocolVersion: TUNNEL_PROTOCOL_VERSIONS[0],
            features: [],
            hostnames: [`conformance.${runtime.engineDomain}`],
        });
        await expectProtocolError(ctx, readyFirst, findings, 'a ready before any challenge');

        const binaryFirst = await wait();
        sendChallenge(binaryFirst);
        await answeredAuth(ctx, binaryFirst);
        binaryFirst.sendBinary(encodeFrame({ type: FrameType.WINDOW, streamId: StreamId.parse(1), increment: 1024 }));
        await expectProtocolError(ctx, binaryFirst, findings, 'a binary frame before ready');

        const textAfter = await wait();
        const textChallenge = sendChallenge(textAfter);
        const auth = await answeredAuth(ctx, textAfter);
        if (runtime.complete(textAfter, textChallenge, auth) === null) fail('no common protocol version');
        textAfter.sendJson(textChallenge);
        await expectProtocolError(ctx, textAfter, findings, 'a text message after ready');
    });
    return findings.outcome();
};
