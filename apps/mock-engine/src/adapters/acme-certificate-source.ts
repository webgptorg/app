import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Hostname } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { Logger } from '../domain/logger';
import { secret } from '../domain/secret';
import type { CertificateIssuer } from '../domain/tls/certificate-issuer';
import { IssueFailedError } from '../domain/tls/certificate-issuer';
import type { ManagedCertificateSource, TlsCredentials } from '../domain/tls/certificate-source';
import type { CertificateValidity } from '../domain/tls/renewal-policy';
import { nextRenewalCheckMs, renewalDue, renewalRetryDelayMs } from '../domain/tls/renewal-policy';
import { AcmeSetupError } from './acme-account-key';
import { currentUid, ensurePrivateDirectory, lstatOrNull, privacyProblem, replacePrivateFile } from './private-files';

export const ACME_TLS_DIRECTORY = 'tls';
export const ACME_CERTIFICATE_FILE = 'certificate.pem';
export const ACME_KEY_FILE = 'key.pem';
/** One issuance, order to download, against a CA that answers; past it the attempt counts as failed and is retried. */
export const ISSUE_TIMEOUT_MS = 120_000;

export interface AcmeCertificateSourceDeps {
    readonly issuer: CertificateIssuer;
    readonly dataDir: string;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly issueTimeoutMs?: number;
}

export interface AcmeCertificateSource extends ManagedCertificateSource {
    /**
     * A relay routes the engine's hostnames now. Issuance waits for it: the CA validates through a relay, so an
     * attempt before any tunnel is up could only fail.
     */
    routable(): void;
}

interface Held {
    readonly credentials: TlsCredentials;
    readonly leaf: X509Certificate;
    readonly validity: CertificateValidity;
}

class IssueTimeoutError extends Error {
    constructor() {
        super('ACME issuance timed out');
        this.name = 'IssueTimeoutError';
    }
}

/** Throws when the chain does not start with a certificate for the key: a CA bug or a mixed-up store. */
function hold(credentials: TlsCredentials): Held {
    const leaf = new X509Certificate(credentials.certificateChainPem);
    if (!leaf.checkPrivateKey(createPrivateKey(credentials.privateKeyPem.reveal()))) {
        throw new Error('the certificate does not belong to its key');
    }
    return {
        credentials,
        leaf,
        validity: { notBeforeMs: leaf.validFromDate.getTime(), notAfterMs: leaf.validToDate.getTime() },
    };
}

async function loadStored(directory: string, logger: Logger): Promise<Held | undefined> {
    const uid = currentUid();
    const files = [
        { label: 'ACME certificate', path: join(directory, ACME_CERTIFICATE_FILE), kind: 'file' },
        { label: 'ACME certificate key', path: join(directory, ACME_KEY_FILE), kind: 'file' },
    ] as const;
    for (const file of files) {
        const stats = await lstatOrNull(file.path);
        if (stats === null) return undefined;
        const problem = privacyProblem(stats, file, uid);
        if (problem !== null) throw new AcmeSetupError(problem);
    }
    try {
        const held = hold({
            certificateChainPem: await readFile(files[0].path, 'utf8'),
            privateKeyPem: secret(await readFile(files[1].path, 'utf8')),
        });
        logger.info('acme.certificate-loaded', { notAfter: held.leaf.validToDate.toISOString() });
        return held;
    } catch {
        // A crash between writing the key and the chain leaves a pair that does not match: issue a new one.
        logger.warn('acme.certificate-unusable', {});
        return undefined;
    }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
            reject(signal.reason as Error);
        });
        work.then(resolve, reject);
    });
}

/**
 * Certificates from an ACME CA via TLS-ALPN-01, kept in `PTBK_DATA_DIR/tls/` (0600) so a restart serves the same one.
 * One certificate covers every hostname. It is renewed once a third of its lifetime remains, looked at every 12 h and
 * at startup; a failed attempt is retried with backoff while the current certificate keeps being served, and a renewal
 * reaches new connections through `onChange` while open ones carry on.
 */
export async function createAcmeCertificateSource(deps: AcmeCertificateSourceDeps): Promise<AcmeCertificateSource> {
    const { issuer, clock, logger } = deps;
    const directory = join(deps.dataDir, ACME_TLS_DIRECTORY);
    const problem = await ensurePrivateDirectory(
        { label: 'ACME certificate directory', path: directory, kind: 'directory' },
        currentUid(),
    );
    if (problem !== null) throw new AcmeSetupError(problem);
    let held = await loadStored(directory, logger);
    const hostnames = new Set<Hostname>();
    const listeners = new Set<() => void>();
    let routable = false;
    let closed = false;
    let issuing: AbortController | undefined;
    let cancelCheck: (() => void) | undefined;
    let failures = 0;

    const covers = (hostname: Hostname): boolean => held?.leaf.checkHost(hostname) !== undefined;

    function scheduleCheck(delayMs: number): void {
        cancelCheck?.();
        cancelCheck = clock.setTimeout(evaluate, delayMs);
    }

    function evaluate(): void {
        cancelCheck?.();
        cancelCheck = undefined;
        if (closed || !routable || issuing !== undefined || hostnames.size === 0) return;
        const nowMs = clock.nowMs();
        if (held !== undefined && [...hostnames].every(covers) && !renewalDue(held.validity, nowMs)) {
            scheduleCheck(nextRenewalCheckMs(held.validity, nowMs));
            return;
        }
        void issue();
    }

    async function store(credentials: TlsCredentials): Promise<void> {
        await replacePrivateFile(join(directory, ACME_KEY_FILE), credentials.privateKeyPem.reveal());
        await replacePrivateFile(join(directory, ACME_CERTIFICATE_FILE), credentials.certificateChainPem);
    }

    async function issue(): Promise<void> {
        const controller = new AbortController();
        issuing = controller;
        const wanted = [...hostnames];
        const cancelTimeout = clock.setTimeout(() => {
            controller.abort(new IssueTimeoutError());
        }, deps.issueTimeoutMs ?? ISSUE_TIMEOUT_MS);
        try {
            const issued = hold(await abortable(issuer.issue(wanted, controller.signal), controller.signal));
            await store(issued.credentials);
            held = issued;
            failures = 0;
            logger.info('acme.certificate-issued', {
                hostnames: wanted.length,
                notAfter: issued.leaf.validToDate.toISOString(),
            });
            for (const listener of [...listeners]) listener();
        } catch (error) {
            if (closed) return;
            failures++;
            const retryInMs = renewalRetryDelayMs(failures);
            logger.warn('acme.issue-failed', {
                problem: error instanceof Error ? error.name : 'unknown',
                stage: error instanceof IssueFailedError ? error.stage : 'none',
                failures,
                retryInMs,
                serving: held !== undefined,
            });
            scheduleCheck(retryInMs);
            return;
        } finally {
            controller.abort();
            cancelTimeout();
            issuing = undefined;
        }
        evaluate();
    }

    return {
        current: (hostname) => (hostnames.has(hostname) && covers(hostname) ? held?.credentials : undefined),
        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        addHostnames(added) {
            const before = hostnames.size;
            for (const hostname of added) hostnames.add(hostname);
            if (hostnames.size !== before) evaluate();
        },
        routable() {
            if (routable) return;
            routable = true;
            evaluate();
        },
        close() {
            closed = true;
            cancelCheck?.();
            cancelCheck = undefined;
            issuing?.abort();
        },
    };
}
