import type { EngineId, Hostname, RegistryEntry, Signer } from '@ptbk/protocol';
import {
    Hostname as HostnameSchema,
    createWebCryptoSigner,
    defaultHostname,
    deriveEngineId,
    ed25519PublicKeyFromBytes,
    ed25519SignatureFromBytes,
    importEd25519PrivateKey,
    signHostnameClaim,
} from '@ptbk/protocol';

export const ENGINE_DOMAIN = HostnameSchema.parse('engine.test');

export interface TestEngine {
    readonly engineId: EngineId;
    readonly defaultHostname: Hostname;
    readonly entry: RegistryEntry;
    /** The engine key, to sign tunnel `auth` in tests. */
    readonly signer: Signer;
}

/** A deterministic engine (key from `seed`) whose entry lists its default hostname and validly claimed `custom` ones. */
export async function createTestEngine(seed: number, custom: readonly string[] = []): Promise<TestEngine> {
    const signer = await createWebCryptoSigner(
        await importEd25519PrivateKey(new Uint8Array(32).fill(seed), { extractable: false }),
    );
    const engineId = await deriveEngineId(signer.publicKey());
    const ownDefault = defaultHostname(engineId, ENGINE_DOMAIN);
    const customHostnames = custom.map((hostname) => HostnameSchema.parse(hostname));
    const claims = await Promise.all(
        customHostnames.map(async (hostname) => ({
            hostname,
            sig: ed25519SignatureFromBytes(await signHostnameClaim(signer, hostname, engineId)),
        })),
    );
    return {
        engineId,
        defaultHostname: ownDefault,
        entry: {
            enginePublicKey: ed25519PublicKeyFromBytes(signer.publicKey()),
            hostnames: [ownDefault, ...customHostnames],
            claims,
            status: 'active',
        },
        signer,
    };
}
