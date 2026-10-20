import { generateKeyPairSync, randomBytes } from 'node:crypto';

import {
    KEY_USAGE,
    OID,
    basicConstraints,
    extendedKeyUsage,
    keyUsage,
    signCertificate,
    subjectAltName,
} from '../adapters/x509/certificate';

const HOUR_MS = 3_600_000;

export interface TestCertificate {
    readonly certPem: string;
    readonly keyPem: string;
}

export interface TestCa {
    readonly certPem: string;
    /** A server certificate for `hostnames` (subjectAltName dNSName), signed by this CA. */
    issue(hostnames: readonly string[]): TestCertificate;
}

export interface TestCaOptions {
    /** Serial number bytes for each certificate; random 16 bytes by default. Lets tests pin edge-case serials. */
    readonly serial?: () => Buffer;
}

/** A throwaway, unconstrained ECDSA P-256 CA generated at test time (relay certificates), so no key is checked in. */
export function createTestCa(commonName: string, options: TestCaOptions = {}): TestCa {
    const serial = options.serial ?? (() => randomBytes(16));
    const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const now = Date.now();
    const validity = { notBefore: new Date(now - HOUR_MS), notAfter: new Date(now + 24 * HOUR_MS) };
    const certPem = signCertificate({
        subject: commonName,
        issuer: commonName,
        serial: serial(),
        ...validity,
        publicKey: ca.publicKey,
        issuerKey: ca.privateKey,
        extensions: [basicConstraints({ ca: true, pathLen: 0 }), keyUsage(KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign)],
    });
    return {
        certPem,
        issue(hostnames) {
            const leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' });
            const leafPem = signCertificate({
                subject: hostnames[0] ?? 'leaf',
                issuer: commonName,
                serial: serial(),
                ...validity,
                publicKey: leaf.publicKey,
                issuerKey: ca.privateKey,
                extensions: [
                    basicConstraints({ ca: false }),
                    keyUsage(KEY_USAGE.digitalSignature),
                    extendedKeyUsage(OID.serverAuth),
                    subjectAltName(hostnames),
                ],
            });
            return { certPem: leafPem, keyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
        },
    };
}
