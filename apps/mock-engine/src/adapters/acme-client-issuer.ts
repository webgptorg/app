import { generateKeyPairSync } from 'node:crypto';

import type { Hostname } from '@ptbk/protocol';
import { Hostname as HostnameSchema } from '@ptbk/protocol';
import { Client, crypto as acmeCrypto } from 'acme-client';
import type { Authorization, Order } from 'acme-client';

import type { Logger } from '../domain/logger';
import type { Secret } from '../domain/secret';
import { secret } from '../domain/secret';
import type { AcmeChallenges } from '../domain/tls/acme-challenges';
import type { CertificateIssuer, IssueStage } from '../domain/tls/certificate-issuer';
import { IssueFailedError } from '../domain/tls/certificate-issuer';
import type { TlsCredentials } from '../domain/tls/certificate-source';

const TLS_ALPN_01 = 'tls-alpn-01';

export interface AcmeClientIssuerDeps {
    readonly directoryUrl: string;
    /** The ACME account key: never the engine key (see acme-account-key.ts). */
    readonly accountKey: Secret;
    readonly email: string | null;
    readonly challenges: AcmeChallenges;
    readonly logger: Logger;
}

function newPrivateKeyPem(): string {
    return generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
}

async function stage<T>(name: IssueStage, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    try {
        return await run();
    } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new IssueFailedError(name, { cause: error });
    }
}

/**
 * TLS-ALPN-01 issuance with `acme-client` 5.4.0 (ADR 0014: for the Pebble spike only; unmaintained since 2024). The
 * ACME server's own TLS trust comes from the process (NODE_EXTRA_CA_CERTS), never from mutating acme-client's global
 * axios instance. Each challenge certificate is registered for the responder just before the CA is told to validate
 * and removed as soon as its authorization settles, valid or not.
 */
export function createAcmeClientIssuer(deps: AcmeClientIssuerDeps): CertificateIssuer {
    const { challenges, logger } = deps;
    const client = new Client({ directoryUrl: deps.directoryUrl, accountKey: deps.accountKey.reveal() });
    let account: Promise<unknown> | undefined;

    async function authorize(authz: Authorization, wanted: ReadonlySet<Hostname>, signal: AbortSignal): Promise<void> {
        if (authz.status === 'valid') return;
        const hostname = HostnameSchema.safeParse(authz.identifier.value);
        if (authz.identifier.type !== 'dns' || !hostname.success || !wanted.has(hostname.data)) {
            throw new IssueFailedError('challenge');
        }
        // acme-client's types list only http-01 and dns-01; the server sends tls-alpn-01 all the same.
        const challenge = authz.challenges.find((offered) => (offered.type as string) === TLS_ALPN_01);
        if (challenge === undefined) throw new IssueFailedError('challenge');
        const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
        const challengeKey = newPrivateKeyPem();
        const [, certificate] = await acmeCrypto.createAlpnCertificate(authz, keyAuthorization, challengeKey);
        const unregister = challenges.register(hostname.data, {
            certificateChainPem: certificate.toString('utf8'),
            privateKeyPem: secret(challengeKey),
        });
        try {
            signal.throwIfAborted();
            await client.completeChallenge(challenge);
            await client.waitForValidStatus(authz);
        } finally {
            unregister();
        }
        logger.info('acme.challenge-valid', { hostname: hostname.data });
    }

    return {
        async issue(hostnames, signal): Promise<TlsCredentials> {
            await stage('account', signal, () => {
                account ??= client
                    .createAccount({
                        termsOfServiceAgreed: true,
                        ...(deps.email === null ? {} : { contact: [`mailto:${deps.email}`] }),
                    })
                    .catch((error: unknown) => {
                        account = undefined;
                        throw error;
                    });
                return account;
            });
            const order: Order = await stage('order', signal, () =>
                client.createOrder({ identifiers: hostnames.map((value) => ({ type: 'dns', value })) }),
            );
            logger.info('acme.order-created', { identifiers: hostnames.length });
            const wanted = new Set(hostnames);
            await stage('challenge', signal, async () => {
                const authorizations = await client.getAuthorizations(order);
                await Promise.all(authorizations.map((authz) => authorize(authz, wanted, signal)));
            });
            const certificateKey = newPrivateKeyPem();
            const finalized = await stage('finalize', signal, async () => {
                // No common name: an engine hostname can exceed its 64 characters, and SANs are what clients check.
                const [, csr] = await acmeCrypto.createCsr({ altNames: [...hostnames] }, certificateKey);
                return client.finalizeOrder(order, csr);
            });
            const chain = await stage('download', signal, () => client.getCertificate(finalized));
            return Object.freeze({ certificateChainPem: chain, privateKeyPem: secret(certificateKey) });
        },
    };
}
