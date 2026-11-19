import type { Bytes, EngineId } from '@ptbk/protocol';
import {
    EngineVersion,
    HEARTBEAT_MAX_BODY_BYTES,
    Heartbeat,
    SIGNING_CONTEXT,
    Timestamp,
    ed25519SignatureToBytes,
    encodeBase64Url,
    parseSignatureHeader,
    signingInput,
    utf8Encode,
    verifyEd25519,
    verifyHeartbeat,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createTestIdentity } from '../../testing/test-identity';
import { createFakeClock } from '../../testing/fake-clock';
import { signerOf } from '../identity/engine-identity';
import type { HeartbeatFacts } from './build-heartbeat';
import { buildSignedHeartbeat, isoSeconds } from './build-heartbeat';

const NOW_MS = Date.parse('2026-10-20T08:00:00.678Z');
const STARTED_MS = NOW_MS - 3_725_400;

async function setup(overrides: Partial<HeartbeatFacts> = {}) {
    const identity = await createTestIdentity();
    const clock = createFakeClock(NOW_MS);
    const facts: HeartbeatFacts = {
        engineId: identity.engineId,
        seq: NOW_MS,
        version: EngineVersion.parse('0.4.2'),
        startedAtMs: STARTED_MS,
        system: { diskPct: 44, ramPct: 46, cpuLoad: 'medium' },
        counts: { agents: 8, members: 5 },
        update: 'none',
        setup: null,
        ...overrides,
    };
    const signed = await buildSignedHeartbeat(facts, { clock, signer: signerOf(identity) });
    return { identity, clock, signed };
}

function signatureBytes(header: string): Bytes {
    const parsed = parseSignatureHeader(header);
    if (parsed.kind !== 'ok') throw new Error('bad header');
    return ed25519SignatureToBytes(parsed.signature);
}

async function sha256(bytes: Bytes): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

describe('buildSignedHeartbeat', () => {
    it("signs the exact body so that C-03's verifyHeartbeat accepts it", async () => {
        const { identity, signed } = await setup();
        const result = await verifyHeartbeat({
            rawBody: signed.rawBody,
            signatureHeader: signed.signature,
            engineId: identity.engineId,
            publicKey: identity.publicKey,
            lastSeq: null,
            now: signed.ts,
        });
        expect(result.kind).toBe('accepted');
        expect(signed.signature).toMatch(/^ed25519=[A-Za-z0-9_-]{86}$/);
    });

    it('signs ptbk-heartbeat-v1 over the raw 32-byte digest, not its hex or base64url text', async () => {
        const { identity, signed } = await setup();
        const digest = await sha256(signed.rawBody);
        expect(digest).toHaveLength(32);
        const signature = signatureBytes(signed.signature);
        const raw = signingInput(SIGNING_CONTEXT.heartbeat, digest);
        expect(verifyEd25519(identity.publicKey, raw, signature)).toBe(true);
        const fromHex = signingInput(SIGNING_CONTEXT.heartbeat, hex(digest));
        expect(verifyEd25519(identity.publicKey, fromHex, signature)).toBe(false);
        const fromBase64Url = signingInput(SIGNING_CONTEXT.heartbeat, encodeBase64Url(digest));
        expect(verifyEd25519(identity.publicKey, fromBase64Url, signature)).toBe(false);
        expect(verifyEd25519(identity.publicKey, signed.rawBody, signature)).toBe(false);
    });

    it('sets ts to the clock in UTC seconds', async () => {
        const { clock, signed } = await setup();
        expect(signed.ts).toBe(isoSeconds(clock.nowMs()));
        expect(signed.ts).toBe('2026-10-20T08:00:00Z');
        expect((JSON.parse(signed.body) as { ts: string }).ts).toBe(signed.ts);
    });

    it("rounds percentages to tens with C-03's rule, halves up", async () => {
        const first = JSON.parse((await setup()).signed.body) as Heartbeat;
        expect(first.diskPct).toBe(40);
        expect(first.ramPct).toBe(50);
        const halves = await setup({ system: { diskPct: 45, ramPct: 44, cpuLoad: 'low' } });
        const second = JSON.parse(halves.signed.body) as Heartbeat;
        expect(second.diskPct).toBe(50);
        expect(second.ramPct).toBe(40);
    });

    it('sends exactly the strict schema and nothing else, well under the size cap', async () => {
        const { identity, signed } = await setup();
        const json = JSON.parse(signed.body) as Record<string, unknown>;
        const heartbeat = Heartbeat.parse(json);
        expect(Object.keys(json).sort()).toEqual(
            [
                'v',
                'engineId',
                'seq',
                'ts',
                'version',
                'uptimeS',
                'diskPct',
                'ramPct',
                'cpuLoad',
                'update',
                'agents',
                'members',
            ].sort(),
        );
        expect(heartbeat).toEqual({
            v: 1,
            engineId: identity.engineId,
            seq: NOW_MS,
            ts: '2026-10-20T08:00:00Z',
            version: '0.4.2',
            uptimeS: 3725,
            diskPct: 40,
            ramPct: 50,
            cpuLoad: 'medium',
            update: 'none',
            agents: 8,
            members: 5,
        });
        expect(signed.rawBody.length).toBeLessThan(HEARTBEAT_MAX_BODY_BYTES);
        expect(signed.body).toBe(new TextDecoder().decode(signed.rawBody));
    });

    it('never reports a negative uptime', async () => {
        const { signed } = await setup({ startedAtMs: NOW_MS + 10_000 });
        expect((JSON.parse(signed.body) as Heartbeat).uptimeS).toBe(0);
    });

    it('throws on input outside the schema instead of sending it', async () => {
        await expect(setup({ engineId: 'not-an-engine-id' as EngineId })).rejects.toThrow();
        await expect(setup({ system: { diskPct: 101, ramPct: 0, cpuLoad: 'low' } })).rejects.toThrow(RangeError);
    });

    it('says whether setup is finished only when the engine has a browser setup', async () => {
        const parsed = async (setupState: HeartbeatFacts['setup']) =>
            Heartbeat.parse(JSON.parse((await setup({ setup: setupState })).signed.body));
        expect(await parsed(null)).not.toHaveProperty('setup');
        expect((await parsed('pending')).setup).toBe('pending');
        expect((await parsed('done')).setup).toBe('done');
    });

    it('a re-serialised body no longer verifies', async () => {
        const { identity, signed } = await setup();
        const reserialised = utf8Encode(JSON.stringify(JSON.parse(signed.body), null, 1));
        const result = await verifyHeartbeat({
            rawBody: reserialised,
            signatureHeader: signed.signature,
            engineId: identity.engineId,
            publicKey: identity.publicKey,
            lastSeq: null,
            now: signed.ts,
        });
        expect(result.kind).toBe('bad-signature');
    });
});

describe('isoSeconds', () => {
    it('drops milliseconds and parses as a protocol Timestamp', () => {
        expect(isoSeconds(Date.parse('2026-10-20T08:00:00.999Z'))).toBe('2026-10-20T08:00:00Z');
        expect(isoSeconds(0)).toBe('1970-01-01T00:00:00Z');
        expect(Timestamp.safeParse(isoSeconds(NOW_MS)).success).toBe(true);
    });
});
