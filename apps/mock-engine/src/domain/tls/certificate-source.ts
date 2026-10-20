import type { Hostname } from '@ptbk/protocol';

import type { Secret } from '../secret';

/** What a TLS server needs for one hostname. The key never leaves the engine and never reaches a log. */
export interface TlsCredentials {
    /** PEM, leaf first. */
    readonly certificateChainPem: string;
    /** PKCS#8 PEM. */
    readonly privateKeyPem: Secret;
}

/**
 * Certificates for the engine's hostnames, read per handshake so a renewal applies to the next connection without a
 * restart. The dev CA implements it now (M-02), ACME later (M-03).
 */
export interface CertificateSource {
    /** Undefined for a hostname this engine holds no certificate for: the handshake must fail. */
    current(hostname: Hostname): TlsCredentials | undefined;
    /** Called after the credentials for any hostname changed; returns a function that removes the listener. */
    onChange(listener: () => void): () => void;
}

/** A source that obtains certificates itself, for the hostnames the engine tells it about. */
export interface ManagedCertificateSource extends CertificateSource {
    /**
     * Adds hostnames to hold certificates for: the default hostname and any the relays confirmed in `ready`. Names
     * already held are ignored; nothing is ever removed, since another relay may still route a name.
     */
    addHostnames(hostnames: readonly Hostname[]): void;
    /** Stops renewals. */
    close(): void;
}
