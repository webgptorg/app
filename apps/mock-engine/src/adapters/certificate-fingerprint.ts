import { X509Certificate, createHash } from 'node:crypto';

import type { TlsCertificateInfo } from '../domain/state/engine-runtime';

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/**
 * The security panel's `tls` facts for the leaf of a PEM chain: the SHA-256 of its DER, which is what a browser shows
 * as the certificate's fingerprint, and its expiry.
 */
export function tlsCertificateInfo(certificateChainPem: string): TlsCertificateInfo {
    const leaf = PEM_CERTIFICATE.exec(certificateChainPem)?.[0];
    if (leaf === undefined) throw new Error('the certificate chain holds no certificate');
    const certificate = new X509Certificate(leaf);
    return {
        certificateSha256: createHash('sha256').update(certificate.raw).digest('hex'),
        notAfter: new Date(certificate.validTo).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
}
