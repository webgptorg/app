import type { Hostname } from '@ptbk/protocol';

import type { TlsCredentials } from './certificate-source';

/**
 * TLS-ALPN-01 challenge certificates while their authorization is pending: the ACME source registers one before it
 * asks the CA to validate and removes it as soon as the authorization settles. In memory only, never on disk.
 */
export interface AcmeChallenges {
    /** Returns the function that removes this registration (and only this one). */
    register(hostname: Hostname, credentials: TlsCredentials): () => void;
    lookup(hostname: Hostname): TlsCredentials | undefined;
}

export function createAcmeChallenges(): AcmeChallenges {
    const pending = new Map<Hostname, TlsCredentials>();
    return {
        register(hostname, credentials) {
            pending.set(hostname, credentials);
            return () => {
                if (pending.get(hostname) === credentials) pending.delete(hostname);
            };
        },
        lookup: (hostname) => pending.get(hostname),
    };
}
