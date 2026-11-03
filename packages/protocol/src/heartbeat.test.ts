import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64Url } from './base64url';
import type { Bytes } from './bytes';
import { concatBytes, utf8Encode } from './bytes';
import type { HeartbeatAck, HeartbeatInput, VerifyHeartbeatInput } from './heartbeat';
import { SIGNED_MEMBER_MESSAGE_MAX_LENGTH } from './member-access';
import {
    HEARTBEAT_MAX_BODY_BYTES,
    HEARTBEAT_REPLY_MAX_BYTES,
    HEARTBEAT_SIGNATURE_HEADER,
    Heartbeat,
    HeartbeatReply,
    MAX_HEARTBEAT_ACKS,
    MAX_HEARTBEAT_REVOCATIONS,
    TolerantHeartbeatReply,
    buildHeartbeat,
    buildHeartbeatV2,
    heartbeatPath,
    parseSignatureHeader,
    signHeartbeat,
    verifyHeartbeat,
} from './heartbeat';
import { EngineId, EngineVersion, Timestamp } from './ids';
import vectors from './signed-message-vectors.json';
import { signingInput } from './signing-input';
import { fromHex, toHex } from './testing/hex';
import type { TestIdentity } from './testing/signers';
import { freshIdentity, vectorIdentity } from './testing/signers';

const TS = '2026-10-16T12:00:00Z';

function inputFor(engineId: EngineId, overrides: Partial<HeartbeatInput> = {}): HeartbeatInput {
    return {
        engineId,
        seq: 1042,
        ts: Timestamp.parse(TS),
        version: EngineVersion.parse('1.8.2'),
        uptimeS: 86_400,
        diskPct: 38,
        ramPct: 55,
        cpuLoad: 'low',
        update: 'none',
        agents: 7,
        members: 3,
        ...overrides,
    };
}

async function sha256(bytes: Bytes): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function headerOver(identity: TestIdentity, message: Bytes): Promise<string> {
    return `ed25519=${encodeBase64Url(await identity.signer.sign(message))}`;
}

interface Signed {
    readonly identity: TestIdentity;
    readonly rawBody: Bytes;
    readonly signatureHeader: string;
    readonly verify: (overrides?: Partial<VerifyHeartbeatInput>) => ReturnType<typeof verifyHeartbeat>;
}

async function signed(body?: (identity: TestIdentity) => Bytes): Promise<Signed> {
    const identity = await freshIdentity();
    const rawBody = body?.(identity) ?? buildHeartbeat(inputFor(identity.engineId));
    const signatureHeader = await signHeartbeat(identity.signer, rawBody);
    return {
        identity,
        rawBody,
        signatureHeader,
        verify: (overrides = {}) =>
            verifyHeartbeat({
                rawBody,
                signatureHeader,
                engineId: identity.engineId,
                publicKey: identity.publicKey,
                lastSeq: 1041,
                now: Timestamp.parse(TS),
                ...overrides,
            }),
    };
}

function json(identity: TestIdentity, change: Record<string, unknown>): Bytes {
    const heartbeat: unknown = JSON.parse(new TextDecoder().decode(buildHeartbeat(inputFor(identity.engineId))));
    return utf8Encode(JSON.stringify({ ...(heartbeat as object), ...change }));
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('heartbeat golden vector (src/signed-message-vectors.json)', () => {
    it('builds the exact body, digest and signing input', async () => {
        const body = buildHeartbeat(inputFor(EngineId.parse(vectors.key.engineId)));
        expect(new TextDecoder().decode(body)).toBe(vectors.heartbeat.body);
        expect(toHex(await sha256(body))).toBe(vectors.heartbeat.bodySha256Hex);
        const input = signingInput('ptbk-heartbeat-v1', fromHex(vectors.heartbeat.bodySha256Hex));
        expect(toHex(input)).toBe(vectors.heartbeat.signingInputHex);
    });

    it('signs to the exact header', async () => {
        const { signer } = await vectorIdentity();
        await expect(signHeartbeat(signer, utf8Encode(vectors.heartbeat.body))).resolves.toBe(
            vectors.heartbeat.signatureHeader,
        );
    });

    it('verifies the vector', async () => {
        const { publicKey, engineId } = await vectorIdentity();
        const result = await verifyHeartbeat({
            rawBody: utf8Encode(vectors.heartbeat.body),
            signatureHeader: vectors.heartbeat.signatureHeader,
            engineId,
            publicKey,
            lastSeq: null,
            now: Timestamp.parse(TS),
        });
        expect(result.kind).toBe('accepted');
    });
});

describe('buildHeartbeat', () => {
    it('rounds percentages to the nearest ten, halves up', () => {
        const engineId = EngineId.parse(vectors.key.engineId);
        const cases: [number, number][] = [
            [0, 0],
            [4.999, 0],
            [5, 10],
            [44.9, 40],
            [45, 50],
            [95, 100],
            [100, 100],
        ];
        for (const [raw, rounded] of cases) {
            const body = buildHeartbeat(inputFor(engineId, { diskPct: raw, ramPct: raw }));
            const heartbeat = Heartbeat.parse(JSON.parse(new TextDecoder().decode(body)));
            expect([heartbeat.diskPct, heartbeat.ramPct]).toEqual([rounded, rounded]);
        }
    });

    it.each<[string, Partial<HeartbeatInput>]>([
        ['a negative percentage', { diskPct: -0.1 }],
        ['a percentage over 100', { ramPct: 100.1 }],
        ['a NaN percentage', { diskPct: Number.NaN }],
        ['a fractional seq', { seq: 1.5 }],
        ['a negative uptime', { uptimeS: -1 }],
        ['more than 1,000,000 agents', { agents: 1_000_001 }],
    ])('throws on %s', (_, overrides) => {
        expect(() => buildHeartbeat(inputFor(EngineId.parse(vectors.key.engineId), overrides))).toThrow();
    });

    it('builds the path', () => {
        expect(heartbeatPath(EngineId.parse(vectors.key.engineId))).toBe(
            `/v1/engines/${vectors.key.engineId}/heartbeat`,
        );
    });
});

describe('parseSignatureHeader', () => {
    const value = vectors.heartbeat.signatureHeader;

    it('parses ed25519=<base64url>', () => {
        expect(HEARTBEAT_SIGNATURE_HEADER).toBe('Ptbk-Signature');
        expect(parseSignatureHeader(value)).toEqual({ kind: 'ok', signature: value.slice('ed25519='.length) });
    });

    it.each([
        ['a missing header', null],
        ['undefined', undefined],
        ['an empty value', ''],
        ['an uppercase algorithm', value.replace('ed25519', 'Ed25519')],
        ['another algorithm', value.replace('ed25519', 'ed448')],
        ['no algorithm', value.slice('ed25519='.length)],
        ['spaces around =', value.replace('=', ' = ')],
        ['a trailing space', `${value} `],
        ['padding', `${value}==`],
        ['standard base64', value.replace(/-/g, '+').replace(/_/g, '/').concat('A')],
        ['a truncated signature', value.slice(0, -1)],
        ['two signatures', `${value}, ${value}`],
        ['a hex signature', `ed25519=${'ab'.repeat(64)}`],
    ])('rejects %s', (_, header) => {
        expect(parseSignatureHeader(header)).toEqual({ kind: 'invalid' });
    });
});

describe('verifyHeartbeat', () => {
    it('accepts a signed heartbeat and returns it parsed', async () => {
        const { verify, identity } = await signed();
        const result = await verify();
        expect(result).toEqual({
            kind: 'accepted',
            heartbeat: { ...inputFor(identity.engineId), v: 1, diskPct: 40, ramPct: 60 },
        });
    });

    describe('bad-signature-header', () => {
        it.each([null, 'ed25519=', 'sig=abc'])('for %s', async (signatureHeader) => {
            const { verify } = await signed();
            await expect(verify({ signatureHeader })).resolves.toEqual({ kind: 'bad-signature-header' });
        });
    });

    describe('bad-signature', () => {
        it('for a forged signature', async () => {
            const { verify } = await signed();
            const signatureHeader = `ed25519=${encodeBase64Url(new Uint8Array(64).fill(9))}`;
            await expect(verify({ signatureHeader })).resolves.toEqual({ kind: 'bad-signature' });
        });

        it('for another key', async () => {
            const { verify } = await signed();
            const other = await freshIdentity();
            await expect(verify({ publicKey: other.publicKey })).resolves.toEqual({ kind: 'bad-signature' });
        });

        it('for a changed field', async () => {
            const { verify, identity, rawBody } = await signed();
            const changed = json(identity, { agents: 8 });
            expect(changed.length).toBe(rawBody.length);
            await expect(verify({ rawBody: changed })).resolves.toEqual({ kind: 'bad-signature' });
        });

        it('for the same heartbeat re-serialised with different whitespace', async () => {
            const { verify, rawBody } = await signed();
            const reserialised = utf8Encode(JSON.stringify(JSON.parse(new TextDecoder().decode(rawBody)), null, 1));
            await expect(verify({ rawBody: reserialised })).resolves.toEqual({ kind: 'bad-signature' });
        });

        it.each<[string, (body: Bytes, digest: Bytes) => Bytes]>([
            ['the raw body without the context', (body) => body],
            ['the digest without the context', (_, digest) => digest],
            [
                'the base64url text of the digest',
                (_, digest) => signingInput('ptbk-heartbeat-v1', encodeBase64Url(digest)),
            ],
            ['the hex text of the digest', (_, digest) => signingInput('ptbk-heartbeat-v1', toHex(digest))],
            ['the raw body instead of its digest', (body) => signingInput('ptbk-heartbeat-v1', body)],
            ['the registration context', (_, digest) => signingInput('ptbk-register-v1', digest)],
            ['the tunnel context', (_, digest) => signingInput('ptbk-tunnel-v1', digest)],
        ])('for a signature over %s', async (_, messageOf) => {
            const { verify, identity, rawBody } = await signed();
            const signatureHeader = await headerOver(identity, messageOf(rawBody, await sha256(rawBody)));
            await expect(verify({ signatureHeader })).resolves.toEqual({ kind: 'bad-signature' });
        });

        it('for a registration signature replayed as a heartbeat signature', async () => {
            const { verify, identity } = await signed();
            const registration = signingInput(
                'ptbk-register-v1',
                '1',
                'aaaqeayeaudaocajbifqydiob4',
                identity.publicKey,
            );
            await expect(verify({ signatureHeader: await headerOver(identity, registration) })).resolves.toEqual({
                kind: 'bad-signature',
            });
        });

        it('never parses the body before the signature verifies', async () => {
            const { verify } = await signed();
            const parse = vi.spyOn(JSON, 'parse');
            const result = await verify({ rawBody: utf8Encode('not json'), lastSeq: 1_000_000 });
            expect(result).toEqual({ kind: 'bad-signature' });
            expect(parse).not.toHaveBeenCalled();
        });
    });

    describe('invalid-body (signed by the engine, so the signature verifies)', () => {
        it.each<[string, (identity: TestIdentity) => Bytes]>([
            ['an unknown field', (identity) => json(identity, { hostname: 'leak.example' })],
            ['v: 2', (identity) => json(identity, { v: 2 })],
            ['a percentage not rounded to tens', (identity) => json(identity, { diskPct: 45 })],
            ['an unknown cpuLoad', (identity) => json(identity, { cpuLoad: 'extreme' })],
            ['an unknown update state', (identity) => json(identity, { update: 'failed' })],
            ['free text as version', (identity) => json(identity, { version: 'my secret build' })],
            ['a negative seq', (identity) => json(identity, { seq: -1 })],
            ['an unsafe seq', (identity) => json(identity, { seq: 2 ** 53 })],
            ['more than 1,000,000 members', (identity) => json(identity, { members: 1_000_001 })],
            ['a missing field', (identity) => json(identity, { members: undefined })],
            ['a non-UTC timestamp', (identity) => json(identity, { ts: '2026-10-16T14:00:00+02:00' })],
            ['a JSON array', () => utf8Encode('[]')],
            ['text that is not JSON', () => utf8Encode('v=1')],
            ['invalid UTF-8', () => Uint8Array.of(0x7b, 0xff, 0x7d)],
            ['a byte order mark', (identity) => concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), json(identity, {}))],
        ])('for %s', async (_, body) => {
            const { verify } = await signed(body);
            await expect(verify()).resolves.toEqual({ kind: 'invalid-body' });
        });

        it('for a validly signed body of 4 KiB + 1, while exactly 4 KiB is accepted', async () => {
            const padded = (length: number) => (identity: TestIdentity) => {
                const body = buildHeartbeat(inputFor(identity.engineId));
                return concatBytes(body, utf8Encode(' '.repeat(length - body.length)));
            };
            const atLimit = await signed(padded(HEARTBEAT_MAX_BODY_BYTES));
            expect(atLimit.rawBody.length).toBe(4096);
            expect((await atLimit.verify()).kind).toBe('accepted');
            const over = await signed(padded(HEARTBEAT_MAX_BODY_BYTES + 1));
            await expect(over.verify()).resolves.toEqual({ kind: 'invalid-body' });
        });
    });

    it('engine-mismatch when the body names another engine than the path', async () => {
        const { verify } = await signed();
        const other = await freshIdentity();
        await expect(verify({ engineId: other.engineId })).resolves.toEqual({ kind: 'engine-mismatch' });
    });

    describe('replayed-seq', () => {
        it.each([1042, 1043, 5000])('when lastSeq is %i and seq is 1042', async (lastSeq) => {
            const { verify } = await signed();
            await expect(verify({ lastSeq })).resolves.toEqual({ kind: 'replayed-seq' });
        });

        it('accepts seq = lastSeq + 1, and any seq before the first heartbeat', async () => {
            const { verify } = await signed();
            expect((await verify({ lastSeq: 1041 })).kind).toBe('accepted');
            expect((await verify({ lastSeq: null })).kind).toBe('accepted');
            const first = await signed((identity) => buildHeartbeat(inputFor(identity.engineId, { seq: 0 })));
            expect((await first.verify({ lastSeq: null })).kind).toBe('accepted');
        });
    });

    describe('stale-ts', () => {
        const at = (offsetMs: number) => Timestamp.parse(new Date(Date.parse(TS) + offsetMs).toISOString());

        it.each([-120_000, 120_000, 0])('accepts ts exactly %i ms from now', async (offset) => {
            const { verify } = await signed();
            expect((await verify({ now: at(offset) })).kind).toBe('accepted');
        });

        it.each([-121_000, 121_000, 120_001, -120_001, 86_400_000])(
            'rejects ts %i ms from now, carrying the serverTime passed in',
            async (offset) => {
                const { verify } = await signed();
                const now = at(offset);
                await expect(verify({ now })).resolves.toEqual({ kind: 'stale-ts', serverTime: now });
            },
        );
    });

    it('checks in order: engine before seq, seq before timestamp', async () => {
        const { verify } = await signed();
        const other = await freshIdentity();
        const late = Timestamp.parse('2027-01-01T00:00:00Z');
        await expect(verify({ engineId: other.engineId, lastSeq: 5000, now: late })).resolves.toEqual({
            kind: 'engine-mismatch',
        });
        await expect(verify({ lastSeq: 5000, now: late })).resolves.toEqual({ kind: 'replayed-seq' });
    });

    it('checks the header before the signature and the signature before the body', async () => {
        const { verify } = await signed();
        const notJson = utf8Encode('{');
        await expect(verify({ rawBody: notJson, signatureHeader: null })).resolves.toEqual({
            kind: 'bad-signature-header',
        });
        await expect(verify({ rawBody: notJson })).resolves.toEqual({ kind: 'bad-signature' });
    });
});

describe('heartbeat v2 (ADR 0018)', () => {
    const longestAcks: HeartbeatAck[] = Array.from({ length: MAX_HEARTBEAT_ACKS }, (_, index) => ({
        id: `${'a'.repeat(62)}${String(index).padStart(2, '0')}`,
        outcome: 'refused-disabled',
    }));

    it('adds the pending request count and acks, and stays under the body cap at its largest', async () => {
        const identity = await freshIdentity();
        const rawBody = buildHeartbeatV2({
            ...inputFor(identity.engineId, { agents: 1_000_000, members: 1_000_000, uptimeS: 2 ** 31 }),
            accessRequests: 1_000_000,
            acks: longestAcks,
        });
        expect(rawBody.length).toBeLessThan(HEARTBEAT_MAX_BODY_BYTES);
        const verdict = await verifyHeartbeat({
            rawBody,
            signatureHeader: await signHeartbeat(identity.signer, rawBody),
            engineId: identity.engineId,
            publicKey: identity.publicKey,
            lastSeq: null,
            now: Timestamp.parse(TS),
        });
        expect(verdict.kind).toBe('accepted');
        if (verdict.kind === 'accepted' && verdict.heartbeat.v === 2) {
            expect(verdict.heartbeat.acks).toHaveLength(MAX_HEARTBEAT_ACKS);
            expect(verdict.heartbeat.accessRequests).toBe(1_000_000);
        } else {
            throw new Error('expected a v2 heartbeat');
        }
    });

    it.each([
        ['33 acks', { acks: [...longestAcks, { id: 'b'.repeat(16), outcome: 'approved' }] }],
        ['an unknown outcome', { acks: [{ id: 'c'.repeat(16), outcome: 'maybe' }] }],
        ['an ack ID that is a name', { acks: [{ id: 'Petr Svoboda', outcome: 'approved' }] }],
        ['no request count', { accessRequests: undefined }],
        ['a negative request count', { accessRequests: -1 }],
        ['an ack that carries a name', { acks: [{ id: 'c'.repeat(16), outcome: 'approved', name: 'Petr' }] }],
        ['an ack ID too short to be one the dashboard issued', { acks: [{ id: 'short', outcome: 'approved' }] }],
        ['a field outside the schema', { requesterEmails: ['petr@example.com'] }],
    ])('refuses a v2 body with %s', async (_, change) => {
        const identity = await freshIdentity();
        const base = JSON.parse(
            new TextDecoder().decode(buildHeartbeatV2({ ...inputFor(identity.engineId), accessRequests: 1, acks: [] })),
        ) as Record<string, unknown>;
        const rawBody = utf8Encode(JSON.stringify({ ...base, ...change }));
        const verdict = await verifyHeartbeat({
            rawBody,
            signatureHeader: await signHeartbeat(identity.signer, rawBody),
            engineId: identity.engineId,
            publicKey: identity.publicKey,
            lastSeq: null,
            now: Timestamp.parse(TS),
        });
        expect(verdict).toEqual({ kind: 'invalid-body' });
    });

    it('builds only the schema’s fields, and refuses to build an ack that carries anything else', async () => {
        const identity = await freshIdentity();
        const extra = { ...inputFor(identity.engineId), displayName: 'Petr Svoboda', accessRequests: 1, acks: [] };
        const body = new TextDecoder().decode(buildHeartbeatV2(extra));
        expect(body).not.toContain('Petr');
        const named = [{ id: 'd'.repeat(16), outcome: 'approved', email: 'petr@example.com' }] as HeartbeatAck[];
        expect(() => buildHeartbeatV2({ ...inputFor(identity.engineId), accessRequests: 0, acks: named })).toThrow();
    });

    it('never sends a v2 field in a v1 body', async () => {
        const identity = await freshIdentity();
        const v1 = JSON.parse(new TextDecoder().decode(buildHeartbeat(inputFor(identity.engineId)))) as object;
        expect(Object.keys(v1)).not.toContain('acks');
        expect(Heartbeat.safeParse({ ...v1, acks: [] }).success).toBe(false);
    });

    it('answers with revocations in a reply under its cap, read tolerantly by the engine', () => {
        const largest = {
            v: 1,
            revocations: Array.from({ length: MAX_HEARTBEAT_REVOCATIONS }, () =>
                'r'.repeat(SIGNED_MEMBER_MESSAGE_MAX_LENGTH),
            ),
        };
        expect(HeartbeatReply.safeParse(largest).success).toBe(true);
        expect(utf8Encode(JSON.stringify(largest)).length).toBeLessThan(HEARTBEAT_REPLY_MAX_BYTES);
        expect(HeartbeatReply.safeParse({ ...largest, revocations: [...largest.revocations, 'x'] }).success).toBe(
            false,
        );
        expect(HeartbeatReply.safeParse({ v: 1, revocations: [], plan: 'pro' }).success).toBe(false);
        expect(TolerantHeartbeatReply.parse({ v: 1, revocations: ['t'], plan: 'pro' })).toEqual({
            v: 1,
            revocations: ['t'],
        });
    });
});
