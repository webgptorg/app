import {
    createWebCryptoSigner,
    defaultHostname,
    deriveEngineId,
    ed25519PublicKeyFromBytes,
    EngineVersion,
    generateEd25519KeyPair,
    Hostname,
    signRegistration,
    type Ed25519PublicKey,
    type EngineId,
    type LinkCode,
    type RegisterEngineRequest,
    type RegistrationMode,
    type Signer,
} from '@ptbk/protocol';

import type { OrgId } from '../domain/ids';
import type { EngineRecord } from '../domain/registration/engine-store';

export const TEST_ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');

/** An engine with a fresh Ed25519 key, as the mock engine (M-06) holds one, that signs C-03 registrations. */
export interface TestEngine {
    readonly signer: Signer;
    readonly publicKey: Ed25519PublicKey;
    readonly engineId: EngineId;
    register(
        linkCode: LinkCode,
        options?: { readonly engineVersion?: string; readonly mode?: RegistrationMode },
    ): Promise<RegisterEngineRequest>;
}

export async function createTestEngine(): Promise<TestEngine> {
    const signer = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
    return {
        signer,
        publicKey: ed25519PublicKeyFromBytes(signer.publicKey()),
        engineId: await deriveEngineId(signer.publicKey()),
        register: (linkCode, options = {}) =>
            signRegistration(signer, {
                linkCode,
                engineVersion: EngineVersion.parse(options.engineVersion ?? '1.0.0'),
                mode: options.mode ?? 'tunnel',
            }),
    };
}

/** A stored engine row for `engine` in `orgId`, for store tests that need one without a registration. */
export function engineRecord(
    engine: TestEngine,
    orgId: OrgId,
    overrides: Partial<Omit<EngineRecord, 'engineId' | 'orgId' | 'publicKey' | 'hostname'>> = {},
): EngineRecord {
    return {
        engineId: engine.engineId,
        orgId,
        publicKey: engine.publicKey,
        hostname: defaultHostname(engine.engineId, TEST_ENGINE_DOMAIN),
        mode: 'tunnel',
        engineVersion: EngineVersion.parse('1.0.0'),
        status: 'active',
        statusReason: null,
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_000,
        ...overrides,
    };
}
