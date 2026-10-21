import { generateKeyPairSync } from 'node:crypto';

import type { Hostname } from '@ptbk/protocol';

import {
    KEY_USAGE,
    OID,
    basicConstraints,
    extendedKeyUsage,
    keyUsage,
    signCertificate,
    subjectAltName,
} from '../adapters/x509/certificate';
import type { Clock } from '../domain/clock';
import { secret } from '../domain/secret';
import type { CertificateIssuer, IssueStage } from '../domain/tls/certificate-issuer';
import { IssueFailedError } from '../domain/tls/certificate-issuer';
import type { TlsCredentials } from '../domain/tls/certificate-source';

export type FakeIssueBehaviour =
    { readonly kind: 'issue' } | { readonly kind: 'fail'; readonly stage: IssueStage } | { readonly kind: 'hang' };

export interface FakeIssuer extends CertificateIssuer {
    /** Hostnames of every call, in order. */
    readonly calls: (readonly Hostname[])[];
    /** What the next calls do; `issue` by default. */
    behaviour: FakeIssueBehaviour;
    /** The signal of the latest call. */
    lastSignal(): AbortSignal | undefined;
    /** Settles the latest `hang`ing call with a certificate. */
    release(): void;
    /** The CA every certificate chains to, for clients that verify. */
    readonly caPem: string;
}

/** A CA in memory standing in for an ACME server: certificates valid from the clock's now for `lifetimeMs`. */
export function createFakeIssuer(options: { readonly clock: Clock; readonly lifetimeMs: number }): FakeIssuer {
    const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    // X.509 times have whole seconds; starting on one keeps the validity the test computes exact.
    const second = (ms: number): Date => new Date(Math.floor(ms / 1000) * 1000);
    const caPem = signCertificate({
        subject: 'Fake ACME CA',
        issuer: 'Fake ACME CA',
        notBefore: second(options.clock.nowMs() - 3_600_000),
        notAfter: second(options.clock.nowMs() + 365 * 86_400_000),
        publicKey: ca.publicKey,
        issuerKey: ca.privateKey,
        extensions: [basicConstraints({ ca: true, pathLen: 0 }), keyUsage(KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign)],
    });
    let signal: AbortSignal | undefined;
    let pending: ((credentials: TlsCredentials) => void) | undefined;

    function issueFor(hostnames: readonly Hostname[]): TlsCredentials {
        const leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const notBefore = second(options.clock.nowMs());
        const certificate = signCertificate({
            subject: hostnames[0] ?? 'leaf',
            issuer: 'Fake ACME CA',
            notBefore,
            notAfter: new Date(notBefore.getTime() + options.lifetimeMs),
            publicKey: leaf.publicKey,
            issuerKey: ca.privateKey,
            extensions: [
                basicConstraints({ ca: false }),
                keyUsage(KEY_USAGE.digitalSignature),
                extendedKeyUsage(OID.serverAuth),
                subjectAltName(hostnames),
            ],
        });
        return {
            certificateChainPem: `${certificate}${caPem}`,
            privateKeyPem: secret(leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
        };
    }

    const issuer: FakeIssuer = {
        calls: [],
        behaviour: { kind: 'issue' },
        caPem,
        lastSignal: () => signal,
        release() {
            const hostnames = issuer.calls.at(-1) ?? [];
            pending?.(issueFor(hostnames));
            pending = undefined;
        },
        issue(hostnames, callSignal) {
            issuer.calls.push([...hostnames]);
            signal = callSignal;
            const behaviour = issuer.behaviour;
            switch (behaviour.kind) {
                case 'issue':
                    return Promise.resolve(issueFor(hostnames));
                case 'fail':
                    return Promise.reject(new IssueFailedError(behaviour.stage));
                case 'hang':
                    return new Promise((resolve) => {
                        pending = resolve;
                    });
            }
        },
    };
    return issuer;
}
