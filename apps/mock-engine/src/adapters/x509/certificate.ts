import type { KeyObject } from 'node:crypto';
import { createHash, randomBytes, sign } from 'node:crypto';
import { isIPv4 } from 'node:net';

import type { DerNode } from './der';
import {
    TAG,
    bitString,
    boolean,
    childrenOf,
    constructedContextTag,
    contextTag,
    decodeOid,
    explicit,
    octetString,
    oid,
    readDer,
    sequence,
    set,
    smallInteger,
    time,
    tlv,
    unsignedInteger,
    utf8String,
} from './der';

export const OID = {
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

/** `KeyUsage` bit numbers, counted from the most significant bit of the first byte (RFC 5280 §4.2.1.3). */
export const KEY_USAGE = { digitalSignature: 0, keyCertSign: 5, cRLSign: 6 } as const;

/** `GeneralName` choices used here (RFC 5280 §4.2.1.6), as implicit context tags. */
export const GENERAL_NAME = { dNSName: 2, iPAddress: 7 } as const;

const PEM_LINE_LENGTH = 64;
const SERIAL_BYTES = 16;

export function extension(id: string, critical: boolean, value: Uint8Array): Buffer {
    return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

export function basicConstraints(options: { readonly ca: false } | { readonly ca: true; readonly pathLen: number }) {
    return extension(
        OID.basicConstraints,
        true,
        options.ca ? sequence(boolean(true), smallInteger(options.pathLen)) : sequence(),
    );
}

export function keyUsage(...bits: readonly number[]): Buffer {
    const value = bits.reduce((byte, bit) => byte | (0x80 >> bit), 0);
    const unused = Math.min(...bits.map((bit) => 7 - bit));
    return extension(OID.keyUsage, true, bitString(Buffer.of(value), unused));
}

export function extendedKeyUsage(...purposes: readonly string[]): Buffer {
    return extension(OID.extKeyUsage, false, sequence(...purposes.map(oid)));
}

function generalName(name: string): Buffer {
    if (isIPv4(name)) {
        return tlv(contextTag(GENERAL_NAME.iPAddress), Buffer.from(name.split('.').map(Number)));
    }
    return tlv(contextTag(GENERAL_NAME.dNSName), Buffer.from(name, 'ascii'));
}

/** DNS names, or IPv4 literals as `iPAddress` (only to prove the dev CA's constraints refuse them). */
export function subjectAltName(names: readonly string[]): Buffer {
    return extension(OID.subjectAltName, false, sequence(...names.map(generalName)));
}

const ANY_IPV4 = Buffer.alloc(8);
const ANY_IPV6 = Buffer.alloc(32);

/**
 * RFC 5280 §4.2.1.10, critical: only names under `permittedDomains` and no IP address at all (`0.0.0.0/0` and `::/0`
 * as address plus mask), so a leaked dev CA cannot vouch for a real site.
 */
export function nameConstraints(permittedDomains: readonly string[]): Buffer {
    const subtree = (base: Buffer): Buffer => sequence(base);
    const permitted = permittedDomains.map((domain) =>
        subtree(tlv(contextTag(GENERAL_NAME.dNSName), Buffer.from(domain, 'ascii'))),
    );
    const excluded = [ANY_IPV4, ANY_IPV6].map((range) => subtree(tlv(contextTag(GENERAL_NAME.iPAddress), range)));
    return extension(
        OID.nameConstraints,
        true,
        sequence(tlv(constructedContextTag(0), ...permitted), tlv(constructedContextTag(1), ...excluded)),
    );
}

/** The raw `subjectPublicKey` bits of an SPKI, which key identifiers hash (RFC 5280 §4.2.1.2, method 1). */
function keyIdentifier(publicKey: KeyObject): Buffer {
    const spki = readDer(publicKey.export({ type: 'spki', format: 'der' }));
    const bits = childrenOf(spki)[1];
    if (bits?.tag !== TAG.bitString) throw new Error('unexpected SubjectPublicKeyInfo');
    return createHash('sha1').update(bits.content.subarray(1)).digest();
}

export function subjectKeyIdentifier(publicKey: KeyObject): Buffer {
    return extension(OID.subjectKeyIdentifier, false, octetString(keyIdentifier(publicKey)));
}

export function authorityKeyIdentifier(issuerPublicKey: KeyObject): Buffer {
    return extension(OID.authorityKeyIdentifier, false, sequence(tlv(contextTag(0), keyIdentifier(issuerPublicKey))));
}

function name(commonName: string): Buffer {
    return sequence(set(sequence(oid(OID.commonName), utf8String(commonName))));
}

export function toPem(label: 'CERTIFICATE', der: Uint8Array): string {
    const base64 = Buffer.from(der).toString('base64');
    const lines: string[] = [];
    for (let offset = 0; offset < base64.length; offset += PEM_LINE_LENGTH) {
        lines.push(base64.slice(offset, offset + PEM_LINE_LENGTH));
    }
    return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export interface CertificateFields {
    readonly subject: string;
    /** Big-endian serial bytes; random 128 bits by default. Encoded as a minimal, non-negative INTEGER. */
    readonly serial?: Uint8Array;
    readonly issuer: string;
    readonly notBefore: Date;
    readonly notAfter: Date;
    readonly publicKey: KeyObject;
    /** ECDSA P-256 key that signs (SHA-256). */
    readonly issuerKey: KeyObject;
    readonly extensions: readonly Buffer[];
}

/** An X.509 v3 certificate as PEM. */
export function signCertificate(fields: CertificateFields): string {
    const algorithm = sequence(oid(OID.ecdsaWithSha256));
    const tbs = sequence(
        explicit(0, smallInteger(2)),
        unsignedInteger(fields.serial ?? randomBytes(SERIAL_BYTES)),
        algorithm,
        name(fields.issuer),
        sequence(time(fields.notBefore), time(fields.notAfter)),
        name(fields.subject),
        fields.publicKey.export({ type: 'spki', format: 'der' }),
        explicit(3, sequence(...fields.extensions)),
    );
    return toPem('CERTIFICATE', sequence(tbs, algorithm, bitString(sign('sha256', tbs, fields.issuerKey))));
}

/** The `extensions` of a DER certificate by OID, each with its criticality and value. */
export function certificateExtensions(
    der: Uint8Array,
): ReadonlyMap<string, { readonly critical: boolean; readonly value: DerNode }> {
    const [tbs] = childrenOf(readDer(der));
    if (tbs === undefined) throw new Error('empty certificate');
    const wrapper = childrenOf(tbs).find((node) => node.tag === constructedContextTag(3));
    const extensions = wrapper === undefined ? undefined : childrenOf(wrapper)[0];
    const list = extensions === undefined ? [] : childrenOf(extensions);
    const result = new Map<string, { readonly critical: boolean; readonly value: DerNode }>();
    for (const item of list) {
        const parts = childrenOf(item);
        const id = parts[0];
        const last = parts.at(-1);
        if (id === undefined || last?.tag !== TAG.octetString) throw new Error('malformed extension');
        const critical = parts.length === 3 && parts[1]?.tag === TAG.boolean && parts[1].content[0] !== 0;
        result.set(decodeOid(id), { critical, value: readDer(last.content) });
    }
    return result;
}
