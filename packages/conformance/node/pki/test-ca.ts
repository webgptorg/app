import type { KeyObject } from 'node:crypto';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isIPv4 } from 'node:net';

import {
    bitString,
    boolean,
    constructedContextTag,
    contextTag,
    explicit,
    octetString,
    oid,
    sequence,
    set,
    time,
    tlv,
    unsignedInteger,
    utf8String,
} from './der';

const OID = {
    ecdsaWithSha256: '1.2.840.10045.4.3.2',
    commonName: '2.5.4.3',
    subjectKeyIdentifier: '2.5.29.14',
    keyUsage: '2.5.29.15',
    subjectAltName: '2.5.29.17',
    basicConstraints: '2.5.29.19',
    nameConstraints: '2.5.29.30',
    authorityKeyIdentifier: '2.5.29.35',
    extKeyUsage: '2.5.29.37',
    serverAuth: '1.3.6.1.5.5.7.3.1',
} as const;

const KEY_USAGE = { digitalSignature: 0, keyCertSign: 5, cRLSign: 6 } as const;
const DNS_NAME = 2;
const IP_ADDRESS = 7;
const HOUR_MS = 3_600_000;
/** Covers the longest run; a certificate that outlives its run is useless anyway, since the CA key is gone. */
const DEFAULT_LIFETIME_MS = 24 * HOUR_MS;
/** Backdated so a peer whose clock runs a little behind still accepts a certificate issued a moment ago. */
const BACKDATE_MS = HOUR_MS;

export interface IssuedCertificate {
    readonly certPem: string;
    /** PKCS#8 PEM, ECDSA P-256. */
    readonly keyPem: string;
}

export interface IssueOptions {
    readonly notBefore?: Date;
    readonly notAfter?: Date;
}

export interface TestCa {
    /** The CA certificate, PEM: what a peer trusts. */
    readonly certPem: string;
    /** A server certificate for `hostnames` (DNS names, or IPv4 literals), EKU `serverAuth`. */
    issue(hostnames: readonly string[], options?: IssueOptions): IssuedCertificate;
}

export interface TestCaOptions {
    /**
     * A critical name constraint: only these domains and their subdomains, and no IP address at all. The CA the
     * engine is told to trust is constrained to `localhost`, so it cannot vouch for any real site even if it leaked.
     */
    readonly permittedDomains?: readonly string[];
}

/**
 * An ephemeral ECDSA P-256 CA that lives only in memory, for one conformance run. Nothing it issues is written
 * anywhere except where a check puts it.
 */
export function createTestCa(commonName: string, options: TestCaOptions = {}): TestCa {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const now = Date.now();
    const certPem = signCertificate({
        subject: commonName,
        issuer: commonName,
        notBefore: new Date(now - BACKDATE_MS),
        notAfter: new Date(now + DEFAULT_LIFETIME_MS),
        publicKey,
        issuerKey: privateKey,
        extensions: [
            extension(OID.basicConstraints, true, sequence(boolean(true), unsignedInteger(Buffer.of(0)))),
            keyUsage(KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign),
            extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(publicKey))),
            ...(options.permittedDomains === undefined ? [] : [nameConstraints(options.permittedDomains)]),
        ],
    });
    return {
        certPem,
        issue(hostnames, issueOptions = {}) {
            if (hostnames.length === 0) throw new RangeError('a certificate needs at least one hostname');
            const leaf = generateKeyPairSync('ec', { namedCurve: 'P-256' });
            const issuedAt = Date.now();
            return {
                certPem: signCertificate({
                    subject: hostnames[0] ?? '',
                    issuer: commonName,
                    notBefore: issueOptions.notBefore ?? new Date(issuedAt - BACKDATE_MS),
                    notAfter: issueOptions.notAfter ?? new Date(issuedAt + DEFAULT_LIFETIME_MS),
                    publicKey: leaf.publicKey,
                    issuerKey: privateKey,
                    extensions: [
                        extension(OID.basicConstraints, true, sequence()),
                        keyUsage(KEY_USAGE.digitalSignature),
                        extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
                        extension(OID.subjectAltName, false, sequence(...hostnames.map(generalName))),
                        extension(
                            OID.authorityKeyIdentifier,
                            false,
                            sequence(tlv(contextTag(0), keyIdentifier(publicKey))),
                        ),
                    ],
                }),
                keyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            };
        },
    };
}

function extension(id: string, critical: boolean, value: Uint8Array): Buffer {
    return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

function keyUsage(...bits: readonly number[]): Buffer {
    const value = bits.reduce((byte, bit) => byte | (0x80 >> bit), 0);
    const unused = Math.min(...bits.map((bit) => 7 - bit));
    return extension(OID.keyUsage, true, bitString(Buffer.of(value), unused));
}

function generalName(name: string): Buffer {
    if (isIPv4(name)) return tlv(contextTag(IP_ADDRESS), Buffer.from(name.split('.').map(Number)));
    return tlv(contextTag(DNS_NAME), Buffer.from(name, 'ascii'));
}

/** RFC 5280 §4.2.1.10: the permitted DNS subtrees, and every IPv4 and IPv6 address excluded. */
function nameConstraints(permittedDomains: readonly string[]): Buffer {
    const permitted = permittedDomains.map((domain) => sequence(tlv(contextTag(DNS_NAME), Buffer.from(domain))));
    const excluded = [Buffer.alloc(8), Buffer.alloc(32)].map((range) => sequence(tlv(contextTag(IP_ADDRESS), range)));
    return extension(
        OID.nameConstraints,
        true,
        sequence(tlv(constructedContextTag(0), ...permitted), tlv(constructedContextTag(1), ...excluded)),
    );
}

/** SHA-1 of the SPKI's public key bits (RFC 5280 §4.2.1.2, method 1); for P-256 they follow a fixed 26-byte header. */
function keyIdentifier(publicKey: KeyObject): Buffer {
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha1').update(spki.subarray(P256_SPKI_HEADER_BYTES)).digest();
}

const P256_SPKI_HEADER_BYTES = 26;

function name(commonName: string): Buffer {
    return sequence(set(sequence(oid(OID.commonName), utf8String(commonName))));
}

interface CertificateFields {
    readonly subject: string;
    readonly issuer: string;
    readonly notBefore: Date;
    readonly notAfter: Date;
    readonly publicKey: KeyObject;
    readonly issuerKey: KeyObject;
    readonly extensions: readonly Buffer[];
}

function signCertificate(fields: CertificateFields): string {
    const algorithm = sequence(oid(OID.ecdsaWithSha256));
    const tbs = sequence(
        explicit(0, unsignedInteger(Buffer.of(2))),
        unsignedInteger(randomBytes(16)),
        algorithm,
        name(fields.issuer),
        sequence(time(fields.notBefore), time(fields.notAfter)),
        name(fields.subject),
        fields.publicKey.export({ type: 'spki', format: 'der' }),
        explicit(3, sequence(...fields.extensions)),
    );
    const der = sequence(tbs, algorithm, bitString(sign('sha256', tbs, fields.issuerKey)));
    const base64 = der.toString('base64').replace(/.{64}/g, '$&\n');
    return `-----BEGIN CERTIFICATE-----\n${base64.replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
}
