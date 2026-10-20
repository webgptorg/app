import type { KeyObject } from 'node:crypto';
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Hostname } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { Logger } from '../domain/logger';
import { secret } from '../domain/secret';
import type { Secret } from '../domain/secret';
import type { ManagedCertificateSource, TlsCredentials } from '../domain/tls/certificate-source';
import { currentUid, ensurePrivateDirectory, lstatOrNull, privacyProblem, replacePrivateFile } from './private-files';
import { TAG, childrenOf, constructedContextTag, contextTag } from './x509/der';
import {
    GENERAL_NAME,
    KEY_USAGE,
    OID,
    authorityKeyIdentifier,
    basicConstraints,
    certificateExtensions,
    extendedKeyUsage,
    keyUsage,
    nameConstraints,
    signCertificate,
    subjectAltName,
    subjectKeyIdentifier,
} from './x509/certificate';

const DAY_MS = 86_400_000;
export const DEV_CA_LIFETIME_MS = 365 * DAY_MS;
export const LEAF_LIFETIME_MS = 7 * DAY_MS;
/** Renew when a third of the leaf's lifetime remains, as M-03's ACME policy does. */
export const LEAF_RENEW_AFTER_MS = Math.round((LEAF_LIFETIME_MS * 2) / 3);
export const DEV_CA_DIRECTORY = 'dev-ca';
export const DEV_CA_CERT_FILE = 'ca-cert.pem';
export const DEV_CA_KEY_FILE = 'ca-key.pem';
const DEV_CA_NAME = 'Promptbook mock engine dev CA';

/** Startup refusals. Messages name paths and settings, never key material. */
export class DevCaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DevCaError';
    }
}

/** A name-constrained ECDSA P-256 CA that only ever signs mock engine leaves. */
export interface DevCa {
    readonly certificatePem: string;
    readonly certificate: X509Certificate;
    /** A `KeyObject`, so `util.inspect` and `JSON.stringify` never show the key. */
    readonly privateKey: KeyObject;
    /** The DNS subtrees its name constraints permit. */
    readonly permittedDomains: readonly string[];
}

export interface IssuedLeaf {
    readonly certificatePem: string;
    readonly privateKeyPem: Secret;
    readonly notBeforeMs: number;
    readonly notAfterMs: number;
}

/** Certificate times have whole seconds; rounding down keeps `notBefore` at or before the clock. */
function wholeSecond(ms: number): number {
    return Math.floor(ms / 1000) * 1000;
}

function toDevCa(certificatePem: string, privateKey: KeyObject, permittedDomains: readonly string[]): DevCa {
    return Object.freeze({
        certificatePem,
        certificate: new X509Certificate(certificatePem),
        privateKey,
        permittedDomains: Object.freeze([...permittedDomains]),
    });
}

/**
 * A new dev CA valid for a year: name constraints (critical) permit only `permittedDomains` and exclude every IPv4 and
 * IPv6 address, `basicConstraints` CA with `pathLen 0`, key usage `keyCertSign` and `cRLSign` only.
 */
export function createDevCa(permittedDomains: readonly Hostname[], clock: Clock): DevCa {
    if (permittedDomains.length === 0) throw new RangeError('a dev CA needs at least one permitted domain');
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const notBefore = wholeSecond(clock.nowMs());
    const certificatePem = signCertificate({
        subject: DEV_CA_NAME,
        issuer: DEV_CA_NAME,
        notBefore: new Date(notBefore),
        notAfter: new Date(notBefore + DEV_CA_LIFETIME_MS),
        publicKey: keys.publicKey,
        issuerKey: keys.privateKey,
        extensions: [
            basicConstraints({ ca: true, pathLen: 0 }),
            keyUsage(KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign),
            nameConstraints(permittedDomains),
            subjectKeyIdentifier(keys.publicKey),
        ],
    });
    return toDevCa(certificatePem, keys.privateKey, permittedDomains);
}

/**
 * A 7-day leaf for `names` (DNS SANs; an IPv4 literal becomes an `iPAddress` SAN, which the CA's constraints refuse)
 * with key usage `digitalSignature` and EKU `serverAuth`. Validity starts at the clock's current second.
 */
export function issueLeaf(ca: DevCa, names: readonly string[], clock: Clock): IssuedLeaf {
    const [first] = names;
    if (first === undefined) throw new RangeError('a leaf needs at least one name');
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const notBeforeMs = wholeSecond(clock.nowMs());
    const notAfterMs = notBeforeMs + LEAF_LIFETIME_MS;
    const certificatePem = signCertificate({
        subject: first,
        issuer: DEV_CA_NAME,
        notBefore: new Date(notBeforeMs),
        notAfter: new Date(notAfterMs),
        publicKey: keys.publicKey,
        issuerKey: ca.privateKey,
        extensions: [
            basicConstraints({ ca: false }),
            keyUsage(KEY_USAGE.digitalSignature),
            extendedKeyUsage(OID.serverAuth),
            subjectAltName(names),
            authorityKeyIdentifier(ca.certificate.publicKey),
        ],
    });
    return {
        certificatePem,
        privateKeyPem: secret(keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
        notBeforeMs,
        notAfterMs,
    };
}

type Inspection = { readonly kind: 'ok'; readonly permittedDomains: readonly string[] } | { readonly kind: 'invalid' };

const ZERO_IPV4_RANGE = Buffer.alloc(8).toString('hex');
const ZERO_IPV6_RANGE = Buffer.alloc(32).toString('hex');

/**
 * Accepts only a CA certificate shaped like `createDevCa`'s: critical name constraints with DNS-only permitted
 * subtrees and both IP families excluded, `pathLen 0`, and key usage limited to certificate and CRL signing. So a CA
 * provisioned from files (X-01) cannot be an unconstrained one by mistake.
 */
export function inspectDevCaCertificate(certificate: X509Certificate): Inspection {
    try {
        if (!certificate.ca) return { kind: 'invalid' };
        const extensions = certificateExtensions(certificate.raw);
        const constraints = extensions.get(OID.nameConstraints);
        const basic = extensions.get(OID.basicConstraints);
        const usage = extensions.get(OID.keyUsage);
        if (constraints?.critical !== true || basic === undefined || usage?.critical !== true) {
            return { kind: 'invalid' };
        }
        const pathLen = childrenOf(basic.value)[1];
        if (pathLen?.tag !== TAG.integer || pathLen.content.length !== 1 || pathLen.content[0] !== 0) {
            return { kind: 'invalid' };
        }
        // keyCertSign | cRLSign, one unused bit.
        if (usage.value.content.toString('hex') !== '0106') return { kind: 'invalid' };
        const subtrees = childrenOf(constraints.value);
        const permitted = subtrees.find((node) => node.tag === constructedContextTag(0));
        const excluded = subtrees.find((node) => node.tag === constructedContextTag(1));
        if (permitted === undefined || excluded === undefined) return { kind: 'invalid' };
        const bases = (node: typeof permitted) => childrenOf(node).map((subtree) => childrenOf(subtree)[0]);
        const domains: string[] = [];
        for (const base of bases(permitted)) {
            if (base?.tag !== contextTag(GENERAL_NAME.dNSName)) return { kind: 'invalid' };
            domains.push(base.content.toString('ascii'));
        }
        const ranges = new Set(
            bases(excluded)
                .filter((base) => base?.tag === contextTag(GENERAL_NAME.iPAddress))
                .map((base) => base?.content.toString('hex')),
        );
        if (domains.length === 0 || !ranges.has(ZERO_IPV4_RANGE) || !ranges.has(ZERO_IPV6_RANGE)) {
            return { kind: 'invalid' };
        }
        return { kind: 'ok', permittedDomains: domains };
    } catch {
        return { kind: 'invalid' };
    }
}

export interface DevCaFiles {
    readonly certFile: string;
    readonly keyFile: string;
}

export interface LoadDevCaOptions {
    /** `MOCK_DEV_CA_CERT_FILE` and `MOCK_DEV_CA_KEY_FILE`; null generates the CA into `<dataDir>/dev-ca/`. */
    readonly files: DevCaFiles | null;
    readonly dataDir: string;
    /** For a generated CA: `PTBK_ENGINE_DOMAIN` plus `MOCK_DEV_CA_DOMAINS`. */
    readonly permittedDomains: readonly Hostname[];
    readonly clock: Clock;
    readonly logger: Logger;
    /** Owner every generated path must have; null skips the check. Defaults to the process's uid. */
    readonly uid?: number | null;
}

async function readText(path: string, label: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch {
        throw new DevCaError(`${label} ${path} cannot be read`);
    }
}

function parseCa(certificatePem: string, keyPem: string, labels: { cert: string; key: string }): DevCa {
    let certificate: X509Certificate;
    let privateKey: KeyObject;
    try {
        certificate = new X509Certificate(certificatePem);
    } catch {
        throw new DevCaError(`${labels.cert} is not a PEM certificate`);
    }
    try {
        privateKey = createPrivateKey({ key: keyPem, format: 'pem' });
    } catch {
        throw new DevCaError(`${labels.key} is not a PEM private key`);
    }
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new DevCaError(`${labels.key} is not an ECDSA P-256 key`);
    }
    if (!certificate.checkPrivateKey(privateKey)) {
        throw new DevCaError(`${labels.key} does not belong to ${labels.cert}`);
    }
    const inspection = inspectDevCaCertificate(certificate);
    if (inspection.kind === 'invalid') {
        throw new DevCaError(
            `${labels.cert} is not a name-constrained dev CA (critical name constraints with DNS subtrees and every IP excluded, pathLen 0, keyCertSign and cRLSign only)`,
        );
    }
    return toDevCa(certificatePem, privateKey, inspection.permittedDomains);
}

function usableUntil(ca: DevCa, clock: Clock): boolean {
    return Date.parse(ca.certificate.validTo) >= clock.nowMs() + LEAF_LIFETIME_MS;
}

async function loadFromFiles(files: DevCaFiles, options: LoadDevCaOptions): Promise<DevCa> {
    const keyStats = await lstatOrNull(files.keyFile);
    if (keyStats === null) throw new DevCaError(`MOCK_DEV_CA_KEY_FILE ${files.keyFile} cannot be read`);
    // Another tool (X-01's init) provisions these files, possibly as another user, so only the mode is checked.
    const problem = privacyProblem(
        keyStats,
        { label: 'MOCK_DEV_CA_KEY_FILE', path: files.keyFile, kind: 'file' },
        null,
    );
    if (problem !== null) throw new DevCaError(problem);
    const ca = parseCa(
        await readText(files.certFile, 'MOCK_DEV_CA_CERT_FILE'),
        await readText(files.keyFile, 'MOCK_DEV_CA_KEY_FILE'),
        { cert: `MOCK_DEV_CA_CERT_FILE ${files.certFile}`, key: `MOCK_DEV_CA_KEY_FILE ${files.keyFile}` },
    );
    if (!usableUntil(ca, options.clock)) {
        throw new DevCaError(`MOCK_DEV_CA_CERT_FILE ${files.certFile} expires within a leaf's lifetime`);
    }
    return ca;
}

function sameDomains(ca: DevCa, wanted: readonly Hostname[]): boolean {
    const held = new Set(ca.permittedDomains);
    return held.size === new Set(wanted).size && wanted.every((domain) => held.has(domain));
}

async function loadOrGenerate(options: LoadDevCaOptions): Promise<DevCa> {
    const uid = options.uid === undefined ? currentUid() : options.uid;
    const ensure = async (label: string, path: string): Promise<void> => {
        const problem = await ensurePrivateDirectory({ label, path, kind: 'directory' }, uid);
        if (problem !== null) throw new DevCaError(problem);
    };
    const directory = join(options.dataDir, DEV_CA_DIRECTORY);
    await ensure('PTBK_DATA_DIR', options.dataDir);
    await ensure('dev CA directory', directory);
    const certPath = join(directory, DEV_CA_CERT_FILE);
    const keyPath = join(directory, DEV_CA_KEY_FILE);
    const [certStats, keyStats] = await Promise.all([lstatOrNull(certPath), lstatOrNull(keyPath)]);

    let reason: 'missing' | 'domains-changed' | 'expiring' = 'missing';
    if (certStats !== null && keyStats !== null) {
        for (const [path, label] of [
            [certPath, DEV_CA_CERT_FILE],
            [keyPath, DEV_CA_KEY_FILE],
        ] as const) {
            const problem = privacyProblem(await lstat(path), { label, path, kind: 'file' }, uid);
            if (problem !== null) throw new DevCaError(problem);
        }
        const existing = parseCa(await readText(certPath, DEV_CA_CERT_FILE), await readText(keyPath, DEV_CA_KEY_FILE), {
            cert: `${DEV_CA_CERT_FILE} ${certPath}`,
            key: `${DEV_CA_KEY_FILE} ${keyPath}`,
        });
        if (!sameDomains(existing, options.permittedDomains)) reason = 'domains-changed';
        else if (!usableUntil(existing, options.clock)) reason = 'expiring';
        else return existing;
    } else if (certStats !== null || keyStats !== null) {
        throw new DevCaError(
            `dev CA directory ${directory} holds only one of ${DEV_CA_CERT_FILE} and ${DEV_CA_KEY_FILE}`,
        );
    }

    const ca = createDevCa(options.permittedDomains, options.clock);
    // Key first: a crash in between leaves a key without a certificate, which the next start refuses loudly.
    await replacePrivateFile(keyPath, ca.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    await replacePrivateFile(certPath, ca.certificatePem);
    options.logger.info('dev-ca.created', { reason, path: certPath, domains: ca.permittedDomains.join(',') });
    return ca;
}

/**
 * The dev CA from `MOCK_DEV_CA_CERT_FILE` and `MOCK_DEV_CA_KEY_FILE` when set (X-01 provisions them so browsers trust
 * the CA before the engine starts), otherwise from `<dataDir>/dev-ca/`, generated there (0600 files in a 0700
 * directory) on first start and again when the permitted domains change or it nears expiry.
 */
export async function loadOrCreateDevCa(options: LoadDevCaOptions): Promise<DevCa> {
    return options.files === null ? loadOrGenerate(options) : loadFromFiles(options.files, options);
}

export interface DevCaCertificateSourceDeps {
    readonly ca: DevCa;
    readonly clock: Clock;
    readonly logger: Logger;
}

/**
 * One leaf for every hostname the engine holds, re-issued when a hostname is added and when two thirds of its lifetime
 * have passed, so connections never meet an expired certificate.
 */
export function createDevCaCertificateSource(deps: DevCaCertificateSourceDeps): ManagedCertificateSource {
    const { ca, clock, logger } = deps;
    const hostnames = new Set<Hostname>();
    const listeners = new Set<() => void>();
    let credentials: TlsCredentials | undefined;
    let cancelRenewal: (() => void) | undefined;
    let closed = false;

    function issue(): void {
        cancelRenewal?.();
        const leaf = issueLeaf(ca, [...hostnames], clock);
        credentials = Object.freeze({ certificateChainPem: leaf.certificatePem, privateKeyPem: leaf.privateKeyPem });
        logger.info('tls.certificate-issued', {
            source: 'dev-ca',
            hostnames: hostnames.size,
            notAfter: new Date(leaf.notAfterMs).toISOString(),
        });
        cancelRenewal = clock.setTimeout(issue, leaf.notBeforeMs + LEAF_RENEW_AFTER_MS - clock.nowMs());
        for (const listener of [...listeners]) listener();
    }

    return {
        current: (hostname) => (hostnames.has(hostname) ? credentials : undefined),
        onChange(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        addHostnames(added) {
            const before = hostnames.size;
            for (const hostname of added) hostnames.add(hostname);
            if (hostnames.size !== before && !closed) issue();
        },
        close() {
            closed = true;
            cancelRenewal?.();
            cancelRenewal = undefined;
        },
    };
}
