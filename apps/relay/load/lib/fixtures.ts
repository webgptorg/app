import { randomFillSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SecureContext } from 'node:tls';
import { createSecureContext } from 'node:tls';

import type { Bytes, EngineId, Hostname as HostnameType, RegistryEntry, Signer } from '@ptbk/protocol';
import {
    Hostname,
    RelayId,
    createWebCryptoSigner,
    decodeBase64Url,
    defaultHostname,
    deriveEngineId,
    ed25519PublicKeyFromBytes,
    encodeBase64Url,
    importEd25519PrivateKey,
} from '@ptbk/protocol';
import { z } from 'zod';

import type { RelayEndpoint } from './engine-tunnel';

export const RELAY_ID = RelayId.parse('relay.load.test');
export const ENGINE_DOMAIN = Hostname.parse('engine.load.test');
/** The compose service the generator dials; the relay listens on 443 inside the network. */
export const RELAY_HOST = process.env['LOAD_RELAY_HOST'] ?? 'relay';
export const RELAY_PORT = 443;

/**
 * Volumes as docker-compose.load.yml mounts them. Keys never share a volume with what does not own them: the relay
 * sees only its own key and the public files, never an engine key.
 */
export const PATHS = Object.freeze({
    relayCert: '/pki/relay-cert.pem',
    engineCa: '/pki/engine-cert.pem',
    registry: '/pki/registry.json',
    relayKey: '/relay-key/key.pem',
    engines: '/engines/engines.json',
    engineCert: '/engines/engine-cert.pem',
    engineKey: '/engines/engine-key.pem',
    results: '/results',
});

const EngineRecord = z.strictObject({ engineId: z.string(), hostname: z.string(), seed: z.string() });
const EngineRecords = z.array(EngineRecord);
type EngineRecord = z.infer<typeof EngineRecord>;

export interface LoadEngine {
    readonly index: number;
    readonly engineId: EngineId;
    readonly hostname: HostnameType;
    readonly signer: Signer;
}

async function signerFromSeed(seed: Bytes): Promise<Signer> {
    return createWebCryptoSigner(await importEd25519PrivateKey(seed, { extractable: false }));
}

/** A fresh identity, generated at run time and kept only in the run's volume. */
export async function createEngineIdentity(): Promise<{ record: EngineRecord; entry: RegistryEntry }> {
    const seed = randomFillSync(new Uint8Array(32));
    const signer = await signerFromSeed(seed);
    const engineId = await deriveEngineId(signer.publicKey());
    const hostname = defaultHostname(engineId, ENGINE_DOMAIN);
    return {
        record: { engineId, hostname, seed: encodeBase64Url(seed) },
        entry: {
            enginePublicKey: ed25519PublicKeyFromBytes(signer.publicKey()),
            hostnames: [hostname],
            claims: [],
            status: 'active',
        },
    };
}

/** Engines `offset .. offset + count - 1` of the prepared set. */
export async function loadEngines(offset: number, count: number): Promise<LoadEngine[]> {
    const records = EngineRecords.parse(JSON.parse(await readFile(PATHS.engines, 'utf8')));
    if (offset + count > records.length) {
        throw new RangeError(`only ${String(records.length)} engines prepared; rerun prepare with more`);
    }
    return Promise.all(
        records.slice(offset, offset + count).map(async (record, position) => {
            const seed = decodeBase64Url(record.seed);
            if (seed.kind !== 'ok') throw new Error('bad engine seed');
            const signer = await signerFromSeed(seed.bytes);
            return {
                index: offset + position,
                engineId: await deriveEngineId(signer.publicKey()),
                hostname: Hostname.parse(record.hostname),
                signer,
            };
        }),
    );
}

export async function relayEndpoint(): Promise<RelayEndpoint> {
    return {
        host: RELAY_HOST,
        port: RELAY_PORT,
        relayId: RELAY_ID,
        secureContext: createSecureContext({ ca: await readFile(PATHS.relayCert, 'utf8') }),
    };
}

/** What browsers trust: the engines' wildcard certificate. */
export async function engineTrust(): Promise<SecureContext> {
    return createSecureContext({ ca: await readFile(PATHS.engineCa, 'utf8') });
}
