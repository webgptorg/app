import { describe, expect, it } from 'vitest';
import { utf8Encode } from './bytes';
import { defaultHostname } from './engine-id';
import { signHostnameClaim } from './hostname-claim';
import type { EngineId } from './ids';
import { Hostname, ed25519PublicKeyFromBytes, ed25519SignatureFromBytes } from './ids';
import type { HostnameClaim } from './registry';
import {
    MAX_REGISTRY_HOSTNAMES,
    REGISTRY_ENTRY_MAX_BYTES,
    RegistryEntry,
    TolerantRegistryEntry,
    registryPath,
    resolveRoutableHostnames,
} from './registry';
import { signingInput } from './signing-input';
import type { TestIdentity } from './testing/signers';
import { freshIdentity } from './testing/signers';

const engineDomain = Hostname.parse('engines.example');
const custom = Hostname.parse('agents.customer.com');

async function claim(identity: TestIdentity, hostname: Hostname, engineId: EngineId = identity.engineId) {
    const sig = await signHostnameClaim(identity.signer, hostname, engineId);
    return { hostname, sig: ed25519SignatureFromBytes(sig) } satisfies HostnameClaim;
}

function entry(identity: TestIdentity, hostnames: readonly string[], claims: readonly HostnameClaim[]): RegistryEntry {
    return RegistryEntry.parse({
        enginePublicKey: ed25519PublicKeyFromBytes(identity.publicKey),
        hostnames,
        claims,
        status: 'active',
    });
}

describe('RegistryEntry schema', () => {
    const sample = {
        enginePublicKey: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        hostnames: ['eh7ddx5bksrgcytl7bkai36se4.engines.example', 'agents.customer.com'],
        claims: [{ hostname: 'agents.customer.com', sig: 'A'.repeat(85) + 'A' }],
        status: 'active',
    };

    it('parses active and suspended entries', () => {
        expect(RegistryEntry.parse(sample)).toEqual(sample);
        expect(RegistryEntry.parse({ ...sample, status: 'suspended' }).status).toBe('suspended');
    });

    it.each([
        ['an unknown field', { ...sample, orgId: 'org_1' }],
        ['an unknown claim field', { ...sample, claims: [{ ...sample.claims[0], keyId: 'k' }] }],
        ['an unknown status', { ...sample, status: 'pending' }],
        ['a 33rd hostname', { ...sample, hostnames: Array.from({ length: 33 }, (_, i) => `h${String(i)}.example`) }],
        ['an IP hostname', { ...sample, hostnames: ['192.0.2.1'] }],
        ['a short claim signature', { ...sample, claims: [{ hostname: 'agents.customer.com', sig: 'AAAA' }] }],
        ['a missing claims list', { ...sample, claims: undefined }],
    ])('rejects %s', (_, value) => {
        expect(RegistryEntry.safeParse(value).success).toBe(false);
    });

    it('is read tolerantly by the relay: unknown fields stripped at every level, known ones still validated', () => {
        const extended = { ...sample, region: 'eu', claims: [{ ...sample.claims[0], keyId: 'k' }] };
        expect(TolerantRegistryEntry.parse(extended)).toEqual(sample);
        expect(TolerantRegistryEntry.safeParse({ ...extended, status: 'pending' }).success).toBe(false);
    });

    it('fits the largest valid entry in REGISTRY_ENTRY_MAX_BYTES', () => {
        const label = 'a'.repeat(63);
        const hostnames = Array.from({ length: MAX_REGISTRY_HOSTNAMES }, (_, index) =>
            [label, label, label, `${'h'.repeat(51)}${String(index).padStart(2, '0')}`, 'example'].join('.'),
        );
        const largest = {
            ...sample,
            hostnames,
            claims: hostnames.map((hostname) => ({ hostname, sig: sample.claims[0]?.sig })),
        };
        expect(RegistryEntry.safeParse(largest).success).toBe(true);
        expect(utf8Encode(JSON.stringify(largest)).length).toBeLessThan(REGISTRY_ENTRY_MAX_BYTES);
    });

    it('builds the lookup path', async () => {
        const { engineId } = await freshIdentity();
        expect(registryPath(engineId)).toBe(`/internal/v1/engines/${engineId}`);
    });
});

describe('resolveRoutableHostnames', () => {
    it('routes the default hostname without a claim', async () => {
        const engine = await freshIdentity();
        const own = defaultHostname(engine.engineId, engineDomain);
        expect(resolveRoutableHostnames(engine.engineId, entry(engine, [own], []), engineDomain)).toEqual({
            hostnames: [own],
            dropped: [],
        });
    });

    it('returns the default hostname even when the entry omits it, and once when it is listed twice', async () => {
        const engine = await freshIdentity();
        const own = defaultHostname(engine.engineId, engineDomain);
        expect(resolveRoutableHostnames(engine.engineId, entry(engine, [], []), engineDomain).hostnames).toEqual([own]);
        expect(resolveRoutableHostnames(engine.engineId, entry(engine, [own, own], []), engineDomain)).toEqual({
            hostnames: [own],
            dropped: [],
        });
    });

    it('keeps custom hostnames whose claims verify, in entry order', async () => {
        const engine = await freshIdentity();
        const own = defaultHostname(engine.engineId, engineDomain);
        const second = Hostname.parse('chat.other-customer.org');
        const value = entry(engine, [custom, own, second], [await claim(engine, second), await claim(engine, custom)]);
        expect(resolveRoutableHostnames(engine.engineId, value, engineDomain)).toEqual({
            hostnames: [own, custom, second],
            dropped: [],
        });
    });

    it('drops a custom hostname without a claim', async () => {
        const engine = await freshIdentity();
        expect(resolveRoutableHostnames(engine.engineId, entry(engine, [custom], []), engineDomain).dropped).toEqual([
            custom,
        ]);
    });

    it('drops a claim for another engine ID', async () => {
        const engine = await freshIdentity();
        const other = await freshIdentity();
        const value = entry(engine, [custom], [await claim(engine, custom, other.engineId)]);
        expect(resolveRoutableHostnames(engine.engineId, value, engineDomain).dropped).toEqual([custom]);
    });

    it('drops a claim signed by another key', async () => {
        const engine = await freshIdentity();
        const other = await freshIdentity();
        const value = entry(engine, [custom], [await claim(other, custom, engine.engineId)]);
        expect(resolveRoutableHostnames(engine.engineId, value, engineDomain).dropped).toEqual([custom]);
    });

    it('drops a hostname whose claim is for a different hostname', async () => {
        const engine = await freshIdentity();
        const elsewhere = Hostname.parse('agents.elsewhere.com');
        const forged = { hostname: custom, sig: (await claim(engine, elsewhere)).sig };
        expect(resolveRoutableHostnames(engine.engineId, entry(engine, [custom], [forged]), engineDomain)).toEqual({
            hostnames: [defaultHostname(engine.engineId, engineDomain)],
            dropped: [custom],
        });
        const unlisted = entry(engine, [custom], [await claim(engine, elsewhere)]);
        expect(resolveRoutableHostnames(engine.engineId, unlisted, engineDomain).dropped).toEqual([custom]);
    });

    it('drops a claim signed under another context', async () => {
        const engine = await freshIdentity();
        const sig = await engine.signer.sign(signingInput('ptbk-tunnel-v1', custom, engine.engineId));
        const value = entry(engine, [custom], [{ hostname: custom, sig: ed25519SignatureFromBytes(sig) }]);
        expect(resolveRoutableHostnames(engine.engineId, value, engineDomain).dropped).toEqual([custom]);
    });

    it('drops a duplicate hostname entirely, reporting it once', async () => {
        const engine = await freshIdentity();
        const value = entry(engine, [custom, custom], [await claim(engine, custom)]);
        expect(resolveRoutableHostnames(engine.engineId, value, engineDomain)).toEqual({
            hostnames: [defaultHostname(engine.engineId, engineDomain)],
            dropped: [custom],
        });
    });

    it('drops a hostname listed in another case as a duplicate, because hostnames parse lowercase', async () => {
        const engine = await freshIdentity();
        const value = entry(engine, [custom, 'Agents.Customer.COM'], [await claim(engine, custom)]);
        expect(resolveRoutableHostnames(engine.engineId, value, engineDomain).dropped).toEqual([custom]);
    });

    it('drops a hostname with two claims, even if both verify', async () => {
        const engine = await freshIdentity();
        const valid = await claim(engine, custom);
        const value = entry(engine, [custom], [valid, valid]);
        expect(resolveRoutableHostnames(engine.engineId, value, engineDomain).dropped).toEqual([custom]);
    });

    it.each([
        [
            "another engine's default hostname",
            async () => defaultHostname((await freshIdentity()).engineId, engineDomain),
        ],
        ['the engine domain itself', () => Promise.resolve(engineDomain)],
        ['a name inside the engine domain', () => Promise.resolve(Hostname.parse('www.engines.example'))],
    ])('drops %s even with a claim signed by this engine', async (_, hostnameOf) => {
        const engine = await freshIdentity();
        const hostname = await hostnameOf();
        const value = entry(engine, [hostname], [await claim(engine, hostname)]);
        expect(resolveRoutableHostnames(engine.engineId, value, engineDomain).dropped).toEqual([hostname]);
    });

    it('ignores status, so a suspended entry still resolves (the caller refuses the tunnel)', async () => {
        const engine = await freshIdentity();
        const value = { ...entry(engine, [custom], [await claim(engine, custom)]), status: 'suspended' as const };
        expect(resolveRoutableHostnames(engine.engineId, value, engineDomain).hostnames).toContain(custom);
    });

    it('works on an entry read tolerantly', async () => {
        const engine = await freshIdentity();
        const value = TolerantRegistryEntry.parse({
            ...entry(engine, [custom], [{ ...(await claim(engine, custom)) }]),
            region: 'eu',
        });
        expect(resolveRoutableHostnames(engine.engineId, value, engineDomain).hostnames).toContain(custom);
    });
});
