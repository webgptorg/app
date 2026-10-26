import {
    HEARTBEAT_MAX_BODY_BYTES,
    HEARTBEAT_MAX_SKEW_MS,
    Heartbeat,
    deriveEngineId,
    ed25519PublicKeyToBytes,
    parseSignatureHeader,
} from '@ptbk/protocol';

import { Findings } from '../../../src/index';
import type { ReceivedHeartbeat } from '../../fakes/dashboard';
import type { PlatformCheck, PlatformCheckContext } from '../../harness/platform';
import type { LinkedEngine } from '../support';
import { attemptWait, startLinkedEngine } from '../support';

export const SUITE = 'heartbeat';

/** The `n`th heartbeat (1-based) the dashboard received, any verdict. */
async function beats(
    ctx: PlatformCheckContext,
    linked: LinkedEngine,
    count: number,
    since = 0,
): Promise<
    | { readonly ok: true; readonly value: readonly ReceivedHeartbeat[] }
    | { readonly ok: false; readonly reason: string }
> {
    const timeoutMs = ctx.expectations.startTimeoutMs + count * ctx.expectations.heartbeatIntervalMs * 1.5;
    return attemptWait(
        ctx,
        linked,
        count === 1 ? 'send a heartbeat' : `send ${String(count)} heartbeats`,
        () => {
            const received = linked.dashboard.heartbeats.filter((beat) => beat.at >= since);
            return received.length >= count ? received.slice(0, count) : undefined;
        },
        timeoutMs,
    );
}

function parsedBody(beat: ReceivedHeartbeat): unknown {
    try {
        return JSON.parse(beat.rawBody.toString('utf8'));
    } catch {
        return undefined;
    }
}

export const signatureVerifies: PlatformCheck = {
    id: 'heartbeat.signature.verifies',
    suite: SUITE,
    title: 'The first heartbeat goes to heartbeatPath(engineId) with Ptbk-Signature, and verifyHeartbeat accepts it over the exact bytes',
    timeoutMs: (expectations) => expectations.startTimeoutMs * 2 + expectations.heartbeatIntervalMs * 2,
    async run(ctx) {
        const linked = await startLinkedEngine(ctx);
        const received = await beats(ctx, linked, 1);
        if (!received.ok) return { kind: 'fail', detail: received.reason };
        const [beat] = received.value;
        const registration = linked.dashboard.registrations.find((entry) => entry.answer.status === 200);
        const findings = new Findings();
        if (beat === undefined || registration?.request == null) return { kind: 'fail', detail: 'no registration' };
        const engineId = await deriveEngineId(ed25519PublicKeyToBytes(registration.request.enginePublicKey));
        if (beat.pathEngineId !== engineId) findings.add('the heartbeat path does not name the engine ID');
        if (parseSignatureHeader(beat.signatureHeader).kind !== 'ok') {
            findings.add('the Ptbk-Signature header is missing or not ed25519=<base64url of 64 bytes>');
        }
        const verdict = beat.verification?.kind;
        if (verdict === 'bad-signature') {
            findings.add(
                "the signature does not verify over signingInput('ptbk-heartbeat-v1', raw SHA-256 of the exact body)",
            );
        } else if (verdict !== undefined && verdict !== 'accepted' && verdict !== 'bad-signature-header') {
            findings.add(`verifyHeartbeat says ${verdict}`);
        }
        return findings.outcome();
    },
};

export const bodyStrict: PlatformCheck = {
    id: 'heartbeat.body.strict',
    suite: SUITE,
    title: 'Every heartbeat body is within 4 KiB, a strict Heartbeat (percentages in tens), with a current ts and the registered version',
    timeoutMs: (expectations) => expectations.startTimeoutMs * 2 + expectations.heartbeatIntervalMs * 3,
    async run(ctx) {
        const linked = await startLinkedEngine(ctx);
        const received = await beats(ctx, linked, 2);
        if (!received.ok) return { kind: 'fail', detail: received.reason };
        const version = linked.dashboard.registrations.find((entry) => entry.request !== null)?.request?.engineVersion;
        const findings = new Findings();
        received.value.forEach((beat, index) => {
            const name = `heartbeat ${String(index + 1)}`;
            if (beat.rawBody.length > HEARTBEAT_MAX_BODY_BYTES) {
                findings.add(
                    `${name} has ${String(beat.rawBody.length)} bytes, over ${String(HEARTBEAT_MAX_BODY_BYTES)}`,
                );
            }
            const parsed = Heartbeat.safeParse(parsedBody(beat));
            if (!parsed.success) {
                const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(body)'))];
                findings.add(`${name} is not a strict Heartbeat: ${fields.join(', ')}`);
                return;
            }
            if (Math.abs(Date.parse(parsed.data.ts) - beat.at) > HEARTBEAT_MAX_SKEW_MS) {
                findings.add(
                    `${name}: ts is more than ${String(HEARTBEAT_MAX_SKEW_MS / 1000)} s from the time it arrived`,
                );
            }
            if (parsed.data.version !== version) findings.add(`${name}: version is not the registered engineVersion`);
        });
        return findings.outcome();
    },
};

export const seqIncreasing: PlatformCheck = {
    id: 'heartbeat.seq.increasing-across-restarts',
    suite: SUITE,
    title: 'seq strictly increases from beat to beat and across a restart',
    timeoutMs: (expectations) => expectations.startTimeoutMs * 3 + expectations.heartbeatIntervalMs * 5,
    async run(ctx) {
        const linked = await startLinkedEngine(ctx);
        const before = await beats(ctx, linked, 2);
        if (!before.ok) return { kind: 'fail', detail: before.reason };
        const restartedAt = Date.now();
        await linked.engine.restart();
        const after = await beats(ctx, linked, 2, restartedAt);
        if (!after.ok) return { kind: 'fail', detail: `after the restart: ${after.reason}` };
        const seqs = [...before.value, ...after.value].map((beat) => {
            const seq = (parsedBody(beat) as { seq?: unknown } | undefined)?.seq;
            return typeof seq === 'number' ? seq : Number.NaN;
        });
        const findings = new Findings();
        for (let index = 1; index < seqs.length; index++) {
            const previous = seqs[index - 1] ?? Number.NaN;
            const current = seqs[index] ?? Number.NaN;
            if (!(current > previous)) {
                const where = index === 2 ? 'across the restart' : `from beat ${String(index)} to ${String(index + 1)}`;
                findings.add(`seq did not increase ${where}`);
            }
        }
        return findings.outcome();
    },
};
