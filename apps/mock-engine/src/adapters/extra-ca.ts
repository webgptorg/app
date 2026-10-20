import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';

export class TrustedRootsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TrustedRootsError';
    }
}

function isCertificate(pem: string): boolean {
    try {
        return new X509Certificate(pem).raw.length > 0;
    } catch {
        return false;
    }
}

/**
 * Roots for verifying relay certificates: undefined keeps Node's defaults; an extra PEM (the dev relay CA, or a
 * TLS-inspecting proxy's CA) is added to them, never instead of them.
 */
export async function loadTrustedRoots(extraCaFile: string | null): Promise<readonly string[] | undefined> {
    if (extraCaFile === null) return undefined;
    let pem: string;
    try {
        pem = await readFile(extraCaFile, 'utf8');
    } catch {
        throw new TrustedRootsError(`MOCK_EXTRA_CA_FILE ${extraCaFile} cannot be read`);
    }
    if (!pem.includes('-----BEGIN CERTIFICATE-----') || !isCertificate(pem)) {
        throw new TrustedRootsError(`MOCK_EXTRA_CA_FILE ${extraCaFile} is not a PEM certificate`);
    }
    return Object.freeze([...rootCertificates, pem]);
}
