import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defaultHostname, deriveEngineId, engineIdFromDefaultHostname } from './engine-id';
import { EngineId, Hostname } from './ids';
import { fromHex } from './testing/hex';

// RFC 8032 §7.1 TEST 1 public key.
const PUBLIC_KEY = fromHex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
// Computed independently:
//   echo d75a…511a | xxd -r -p | openssl dgst -sha256 -binary \
//     | python3 -c "import sys,base64;print(base64.b32encode(sys.stdin.buffer.read()).decode().lower()[:26])"
// (SHA-256 = 21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9)
const ENGINE_ID = 'eh7ddx5bksrgcytl7bkai36se4';

const engineDomain = Hostname.parse('engines.example');

describe('deriveEngineId', () => {
    it('derives the checked-in engine ID', async () => {
        await expect(deriveEngineId(PUBLIC_KEY)).resolves.toBe(ENGINE_ID);
    });

    it('always matches the schema', async () => {
        await fc.assert(
            fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), async (key) => {
                expect(EngineId.safeParse(await deriveEngineId(key)).success).toBe(true);
            }),
        );
    });

    it.each([0, 31, 33, 43])('refuses a %i-byte key', async (length) => {
        await expect(deriveEngineId(new Uint8Array(length))).rejects.toThrow(RangeError);
    });
});

describe('default hostnames', () => {
    const engineId = EngineId.parse(ENGINE_ID);

    it('builds and recognises the default hostname', () => {
        const hostname = defaultHostname(engineId, engineDomain);
        expect(hostname).toBe(`${ENGINE_ID}.engines.example`);
        expect(engineIdFromDefaultHostname(hostname, engineDomain)).toEqual({ kind: 'default', engineId });
    });

    it('throws when the engine domain is too long for a default hostname', () => {
        const longDomain = Hostname.parse(['a'.repeat(63), 'a'.repeat(63), 'a'.repeat(63), 'a'.repeat(40)].join('.'));
        expect(() => defaultHostname(engineId, longDomain)).toThrow();
    });

    it.each([
        ['another domain', 'agents.customer.com'],
        ['a lookalike suffix', `${ENGINE_ID}.xengines.example`],
        ['the engine domain as a label', `${ENGINE_ID}.engines.example.evil.com`],
        ['a parent of the engine domain', 'example.com'],
    ])('classifies %s as custom', (_, hostname) => {
        expect(engineIdFromDefaultHostname(Hostname.parse(hostname), engineDomain)).toEqual({ kind: 'custom' });
    });

    it.each([
        ['the engine domain itself', 'engines.example'],
        ['a short label', 'abc.engines.example'],
        ['a 27-character label', `${ENGINE_ID}a.engines.example`],
        ['a label outside the alphabet', `${ENGINE_ID.slice(0, 25)}1.engines.example`],
        ['a deeper subdomain', `www.${ENGINE_ID}.engines.example`],
        ['an engine ID with a prefix label', `${ENGINE_ID}.x.engines.example`],
    ])('classifies %s as invalid', (_, hostname) => {
        expect(engineIdFromDefaultHostname(Hostname.parse(hostname), engineDomain)).toEqual({ kind: 'invalid' });
    });

    it('matches case-insensitively, because hostnames are parsed lowercase', () => {
        const hostname = Hostname.parse(`${ENGINE_ID.toUpperCase()}.Engines.Example`);
        expect(engineIdFromDefaultHostname(hostname, engineDomain)).toEqual({ kind: 'default', engineId });
    });
});
