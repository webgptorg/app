import type { Bytes } from '@ptbk/protocol';
import { concatBytes, encodeBase64Std, utf8Encode } from '@ptbk/protocol';

import {
    bitString,
    boolean,
    ecdsaSignatureToDer,
    explicit,
    generalizedTime,
    integer,
    octetString,
    oid,
    sequence,
    set,
    tlv,
    utf8String,
    x509Time,
} from './der';

/**
 * A complete local Sigstore (Fulcio CA, CT log, Rekor, TSA) with ephemeral P-256 keys, minting DSSE bundles that
 * `@sigstore/verify` checks exactly like public-good ones against `trustedRoot`. Portable (WebCrypto only), so the
 * suite can publish provenance for any engine that accepts a configured `trusted_root.json`.
 */
export interface TestSigstore {
    /** A `trusted_root.json` value (`application/vnd.dev.sigstore.trustedroot+json;version=0.1`). */
    readonly trustedRoot: unknown;
    /** The Sigstore bundle JSON text (v0.3, DSSE), as `sigstore.attest()` writes it. */
    attest(input: TestAttestation): Promise<string>;
}

export interface TestCertificateClaims {
    /** Written to Fulcio's issuer extensions, v2 (`…1.8`) and legacy v1 (`…1.1`, always raw bytes). */
    readonly issuer: string;
    /** The certificate's only SAN, a URI. */
    readonly subjectAlternativeName: string;
    /** Further extensions by OID, in this order after the issuer ones (see `FULCIO_OID`). */
    readonly extensions: Readonly<Record<string, string>>;
}

export interface TestAttestation {
    readonly payloadType: string;
    readonly payload: Uint8Array;
    readonly certificate: TestCertificateClaims;
    /** Rekor's integrated time, truncated to the second. */
    readonly integratedTime: Date;
    readonly logIndex: number;
    /** One RFC 3161 timestamp over the signature per entry, truncated to the second. */
    readonly tsaTimes?: readonly Date[];
    /** `raw-octets` writes extension values as bare UTF-8, like Fulcio's v1 extensions, instead of a DER UTF8String. */
    readonly extensionEncoding?: 'utf8string' | 'raw-octets';
    /** Issues the certificate from a CA that is not in `trustedRoot`. */
    readonly untrustedCa?: boolean;
    readonly omitSct?: boolean;
    readonly omitTlogEntry?: boolean;
    /** Logs the entry with an inclusion proof only, so its integrated time is not a verified timestamp. */
    readonly omitInclusionPromise?: boolean;
}

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGNATURE_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;
const DAY_MS = 86_400_000;
/** Fulcio's certificate lifetime. */
const LEAF_LIFETIME_MS = 10 * 60_000;
const BUNDLE_MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json';
const TRUSTED_ROOT_MEDIA_TYPE = 'application/vnd.dev.sigstore.trustedroot+json;version=0.1';
// `.invalid` (RFC 2606) so nothing ever resolves them. @sigstore/verify matches a checkpoint signer by
// `baseUrl.includes(name)`, so the Rekor name must be the URL's host.
const HOST = Object.freeze({
    fulcio: 'fulcio.test-sigstore.invalid',
    rekor: 'rekor.test-sigstore.invalid',
    ctlog: 'ctfe.test-sigstore.invalid',
    tsa: 'tsa.test-sigstore.invalid',
});
const REKOR_TREE_ID = '1';

const OID = Object.freeze({
    ecdsaWithSha256: '1.2.840.10045.4.3.2',
    sha256: '2.16.840.1.101.3.4.2.1',
    commonName: '2.5.4.3',
    organization: '2.5.4.10',
    subjectKeyId: '2.5.29.14',
    keyUsage: '2.5.29.15',
    subjectAltName: '2.5.29.17',
    basicConstraints: '2.5.29.19',
    authorityKeyId: '2.5.29.35',
    extKeyUsage: '2.5.29.37',
    codeSigning: '1.3.6.1.5.5.7.3.3',
    timeStamping: '1.3.6.1.5.5.7.3.8',
    fulcioIssuerV1: '1.3.6.1.4.1.57264.1.1',
    fulcioIssuerV2: '1.3.6.1.4.1.57264.1.8',
    signedCertificateTimestamps: '1.3.6.1.4.1.11129.2.4.2',
    signedData: '1.2.840.113549.1.7.2',
    tstInfo: '1.2.840.113549.1.9.16.1.4',
    contentType: '1.2.840.113549.1.9.3',
    messageDigest: '1.2.840.113549.1.9.4',
    tsaPolicy: '1.3.6.1.4.1.57264.2',
});

const ECDSA_WITH_SHA256 = sequence(oid(OID.ecdsaWithSha256));
const SHA256 = sequence(oid(OID.sha256));
const KEY_USAGE_DIGITAL_SIGNATURE = bitString(Uint8Array.of(0x80), 7);
const KEY_USAGE_CERT_AND_CRL_SIGN = bitString(Uint8Array.of(0x06), 1);
const URI_GENERAL_NAME = 0x86;
const KEY_IDENTIFIER = 0x80;
const SIGNED_ATTRIBUTES = 0xa0;

interface KeyPair {
    readonly privateKey: CryptoKey;
    readonly spki: Bytes;
    /** SHA-256 of the SPKI: a log's ID, and (truncated) a CA's key identifier. */
    readonly keyId: Bytes;
}

interface Authority {
    readonly key: KeyPair;
    readonly name: Bytes;
    readonly certificate: Bytes;
}

interface Validity {
    readonly notBefore: Date;
    readonly notAfter: Date;
}

async function sha256(data: Bytes): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

async function generateKeyPair(): Promise<KeyPair> {
    const keys = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ['sign', 'verify']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
    return { privateKey: keys.privateKey, spki, keyId: await sha256(spki) };
}

async function sign(key: KeyPair, data: Bytes): Promise<Bytes> {
    return ecdsaSignatureToDer(new Uint8Array(await crypto.subtle.sign(SIGNATURE_ALGORITHM, key.privateKey, data)));
}

function randomBytes(length: number): Bytes {
    return crypto.getRandomValues(new Uint8Array(length));
}

function uint(value: number | bigint, bytes: number): Bytes {
    const result = new Uint8Array(bytes);
    let rest = BigInt(value);
    for (let index = bytes - 1; index >= 0; index -= 1) {
        result[index] = Number(rest & 0xffn);
        rest >>= 8n;
    }
    return result;
}

function distinguishedName(commonName: string): Bytes {
    return sequence(
        set(sequence(oid(OID.organization), utf8String('test-sigstore'))),
        set(sequence(oid(OID.commonName), utf8String(commonName))),
    );
}

function extension(id: string, critical: boolean, value: Bytes): Bytes {
    return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

function keyIdentifier(key: KeyPair): Bytes {
    return key.keyId.slice(0, 20);
}

function issuedBy(issuer: Authority): Bytes {
    return extension(OID.authorityKeyId, false, sequence(tlv(KEY_IDENTIFIER, keyIdentifier(issuer.key))));
}

function tbsCertificate(fields: {
    readonly serial: Bytes;
    readonly issuer: Bytes;
    readonly subject: Bytes;
    readonly validity: Validity;
    readonly key: KeyPair;
    readonly extensions: readonly Bytes[];
}): Bytes {
    return sequence(
        explicit(0, integer(2)),
        integer(fields.serial),
        ECDSA_WITH_SHA256,
        fields.issuer,
        sequence(x509Time(fields.validity.notBefore), x509Time(fields.validity.notAfter)),
        fields.subject,
        fields.key.spki,
        explicit(3, sequence(...fields.extensions)),
    );
}

async function signCertificate(tbs: Bytes, signer: KeyPair): Promise<Bytes> {
    return sequence(tbs, ECDSA_WITH_SHA256, bitString(await sign(signer, tbs)));
}

// Positive and never zero-led, so the INTEGER needs no padding byte and serials stay 16 bytes.
function randomSerial(): Bytes {
    const serial = randomBytes(16);
    serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
    return serial;
}

async function createRootCa(commonName: string, validity: Validity): Promise<Authority> {
    const key = await generateKeyPair();
    const name = distinguishedName(commonName);
    const tbs = tbsCertificate({
        serial: randomSerial(),
        issuer: name,
        subject: name,
        validity,
        key,
        extensions: [
            extension(OID.keyUsage, true, KEY_USAGE_CERT_AND_CRL_SIGN),
            extension(OID.basicConstraints, true, sequence(boolean(true))),
            extension(OID.subjectKeyId, false, octetString(keyIdentifier(key))),
        ],
    });
    return { key, name, certificate: await signCertificate(tbs, key) };
}

interface TimestampAuthority {
    readonly key: KeyPair;
    readonly serial: Bytes;
    readonly issuerName: Bytes;
    readonly certificate: Bytes;
}

async function createTimestampAuthority(root: Authority, validity: Validity): Promise<TimestampAuthority> {
    const key = await generateKeyPair();
    const serial = randomSerial();
    const tbs = tbsCertificate({
        serial,
        issuer: root.name,
        subject: distinguishedName('test-sigstore-tsa'),
        validity,
        key,
        extensions: [
            extension(OID.keyUsage, true, KEY_USAGE_DIGITAL_SIGNATURE),
            extension(OID.extKeyUsage, true, sequence(oid(OID.timeStamping))),
            extension(OID.subjectKeyId, false, octetString(keyIdentifier(key))),
            issuedBy(root),
        ],
    });
    return { key, serial, issuerName: root.name, certificate: await signCertificate(tbs, root.key) };
}

/** RFC 6962 §3.2: the SCT list extension value for a precertificate whose TBS is `precertificate`. */
async function signedCertificateTimestamps(
    log: KeyPair,
    issuer: Authority,
    precertificate: Bytes,
    time: Date,
): Promise<Bytes> {
    const timestamp = uint(time.getTime(), 8);
    const noExtensions = uint(0, 2);
    const signed = concatBytes(
        Uint8Array.of(0, 0),
        timestamp,
        uint(1, 2),
        await sha256(issuer.key.spki),
        uint(precertificate.length, 3),
        precertificate,
        noExtensions,
    );
    const signature = await sign(log, signed);
    const sct = concatBytes(
        Uint8Array.of(0),
        log.keyId,
        timestamp,
        noExtensions,
        Uint8Array.of(4, 3),
        uint(signature.length, 2),
        signature,
    );
    return octetString(concatBytes(uint(sct.length + 2, 2), uint(sct.length, 2), sct));
}

/** RFC 3161 `TimeStampResp` over `signature`, the form a bundle's `signedTimestamp` holds. */
async function timestampResponse(tsa: TimestampAuthority, signature: Bytes, time: Date): Promise<Bytes> {
    const tstInfo = sequence(
        integer(1),
        oid(OID.tsaPolicy),
        sequence(SHA256, octetString(await sha256(signature))),
        integer(randomSerial()),
        generalizedTime(time),
    );
    const attributes = [
        sequence(oid(OID.contentType), set(oid(OID.tstInfo))),
        sequence(oid(OID.messageDigest), set(octetString(await sha256(tstInfo)))),
    ];
    // CMS signs the signed attributes as a SET OF but carries them as `[0] IMPLICIT`.
    const attributeSignature = await sign(tsa.key, set(...attributes));
    const signerInfo = sequence(
        integer(1),
        sequence(tsa.issuerName, integer(tsa.serial)),
        SHA256,
        tlv(SIGNED_ATTRIBUTES, ...attributes),
        ECDSA_WITH_SHA256,
        octetString(attributeSignature),
    );
    const signedData = sequence(
        integer(3),
        set(SHA256),
        sequence(oid(OID.tstInfo), explicit(0, octetString(tstInfo))),
        set(signerInfo),
    );
    return sequence(sequence(integer(0)), sequence(oid(OID.signedData), explicit(0, signedData)));
}

function preAuthEncoding(payloadType: string, payload: Uint8Array): Bytes {
    const type = utf8Encode(payloadType);
    return concatBytes(
        utf8Encode(`DSSEv1 ${String(type.length)} `),
        type,
        utf8Encode(` ${String(payload.length)} `),
        payload,
    );
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pem(der: Bytes): string {
    const lines = encodeBase64Std(der).match(/.{1,64}/g) ?? [];
    return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function wholeSeconds(date: Date, field: string): Date {
    const time = date.getTime();
    if (!Number.isFinite(time)) throw new RangeError(`${field} must be a valid date`);
    return new Date(Math.floor(time / 1000) * 1000);
}

function popCount(value: number): number {
    return value.toString(2).replaceAll('0', '').length;
}

interface LogInclusion {
    readonly signedEntryTimestamp: string | undefined;
    readonly inclusionProof: unknown;
}

/**
 * The SET over Rekor's canonical verification payload, and an RFC 6962 inclusion proof in a tree whose last leaf is
 * the entry. Only the root has to be consistent with the leaf, so the sibling hashes are random.
 */
async function logInclusion(
    rekor: KeyPair,
    body: Bytes,
    logIndex: number,
    integratedSeconds: number,
    withPromise: boolean,
): Promise<LogInclusion> {
    let signedEntryTimestamp: string | undefined;
    if (withPromise) {
        // Keys in canonical (sorted) order; every value is a number or plain base64/hex, so this is canonical JSON.
        const payload = JSON.stringify({
            body: encodeBase64Std(body),
            integratedTime: integratedSeconds,
            logID: hex(rekor.keyId),
            logIndex,
        });
        signedEntryTimestamp = encodeBase64Std(await sign(rekor, utf8Encode(payload)));
    }
    const hashes = Array.from({ length: popCount(logIndex) }, () => randomBytes(32));
    let root = await sha256(concatBytes(Uint8Array.of(0), body));
    for (const sibling of hashes) root = await sha256(concatBytes(Uint8Array.of(1), sibling, root));
    const treeSize = logIndex + 1;
    const note = `${HOST.rekor} - ${REKOR_TREE_ID}\n${String(treeSize)}\n${encodeBase64Std(root)}\n`;
    const noteSignature = concatBytes(rekor.keyId.subarray(0, 4), await sign(rekor, utf8Encode(note)));
    return {
        signedEntryTimestamp,
        inclusionProof: {
            logIndex: String(logIndex),
            rootHash: encodeBase64Std(root),
            treeSize: String(treeSize),
            hashes: hashes.map(encodeBase64Std),
            checkpoint: { envelope: `${note}\n— ${HOST.rekor} ${encodeBase64Std(noteSignature)}\n` },
        },
    };
}

function trustedLog(host: string, key: KeyPair, validFrom: Date): unknown {
    return {
        baseUrl: `https://${host}`,
        hashAlgorithm: 'SHA2_256',
        publicKey: {
            rawBytes: encodeBase64Std(key.spki),
            keyDetails: 'PKIX_ECDSA_P256_SHA_256',
            validFor: { start: validFrom.toISOString() },
        },
        logId: { keyId: encodeBase64Std(key.keyId) },
    };
}

function trustedAuthority(host: string, commonName: string, chain: readonly Bytes[], validFrom: Date): unknown {
    return {
        subject: { organization: 'test-sigstore', commonName },
        uri: `https://${host}`,
        certChain: { certificates: chain.map((certificate) => ({ rawBytes: encodeBase64Std(certificate) })) },
        validFor: { start: validFrom.toISOString() },
    };
}

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

/** Keys, CAs and logs valid from a year before `now` to a year after it; certificates last ten minutes. */
export async function createTestSigstore(options: { readonly now: Date }): Promise<TestSigstore> {
    const now = wholeSeconds(options.now, 'now');
    const validity: Validity = {
        notBefore: new Date(now.getTime() - 365 * DAY_MS),
        notAfter: new Date(now.getTime() + 365 * DAY_MS),
    };
    const [fulcio, untrustedFulcio, tsaRoot, rekor, ctlog] = await Promise.all([
        createRootCa('test-sigstore', validity),
        createRootCa('test-sigstore', validity),
        createRootCa('test-sigstore-tsa-root', validity),
        generateKeyPair(),
        generateKeyPair(),
    ]);
    const tsa = await createTimestampAuthority(tsaRoot, validity);
    const trustedRoot = deepFreeze({
        mediaType: TRUSTED_ROOT_MEDIA_TYPE,
        tlogs: [trustedLog(HOST.rekor, rekor, validity.notBefore)],
        certificateAuthorities: [
            trustedAuthority(HOST.fulcio, 'test-sigstore', [fulcio.certificate], validity.notBefore),
        ],
        ctlogs: [trustedLog(HOST.ctlog, ctlog, validity.notBefore)],
        timestampAuthorities: [
            trustedAuthority(HOST.tsa, 'test-sigstore-tsa', [tsa.certificate, tsaRoot.certificate], validity.notBefore),
        ],
    });

    async function attest(input: TestAttestation): Promise<string> {
        if (!Number.isSafeInteger(input.logIndex) || input.logIndex < 0) {
            throw new RangeError('logIndex must be a non-negative safe integer');
        }
        const integratedTime = wholeSeconds(input.integratedTime, 'integratedTime');
        const tsaTimes = (input.tsaTimes ?? []).map((time) => wholeSeconds(time, 'tsaTimes'));
        const logged = input.omitTlogEntry !== true;
        const withPromise = input.omitInclusionPromise !== true;
        // Fulcio issues the certificate at signing; it must cover every timestamp the verifier trusts.
        const trustedTimes = [...tsaTimes, ...(logged && withPromise ? [integratedTime] : [])];
        const issuedAt = new Date(Math.min(...(trustedTimes.length > 0 ? trustedTimes : [integratedTime]).map(Number)));
        const leafValidity = { notBefore: issuedAt, notAfter: new Date(issuedAt.getTime() + LEAF_LIFETIME_MS) };

        const leaf = await generateKeyPair();
        const signature = await sign(leaf, preAuthEncoding(input.payloadType, input.payload));
        const ca = input.untrustedCa === true ? untrustedFulcio : fulcio;
        const claim = (text: string): Bytes =>
            input.extensionEncoding === 'raw-octets' ? utf8Encode(text) : utf8String(text);
        const extensions = [
            extension(OID.keyUsage, true, KEY_USAGE_DIGITAL_SIGNATURE),
            extension(OID.extKeyUsage, false, sequence(oid(OID.codeSigning))),
            extension(OID.subjectKeyId, false, octetString(keyIdentifier(leaf))),
            issuedBy(ca),
            // Critical because the subject is empty (RFC 5280 §4.2.1.6), as in every Fulcio certificate.
            extension(
                OID.subjectAltName,
                true,
                sequence(tlv(URI_GENERAL_NAME, utf8Encode(input.certificate.subjectAlternativeName))),
            ),
            extension(OID.fulcioIssuerV1, false, utf8Encode(input.certificate.issuer)),
            extension(OID.fulcioIssuerV2, false, claim(input.certificate.issuer)),
            ...Object.entries(input.certificate.extensions).map(([id, value]) => extension(id, false, claim(value))),
        ];
        const certificateFields = {
            serial: randomSerial(),
            issuer: ca.name,
            subject: sequence(),
            validity: leafValidity,
            key: leaf,
        };
        const precertificate = tbsCertificate({ ...certificateFields, extensions });
        const tbs =
            input.omitSct === true
                ? precertificate
                : tbsCertificate({
                      ...certificateFields,
                      extensions: [
                          ...extensions,
                          extension(
                              OID.signedCertificateTimestamps,
                              false,
                              await signedCertificateTimestamps(ctlog, ca, precertificate, issuedAt),
                          ),
                      ],
                  });
        const certificate = await signCertificate(tbs, ca.key);

        const payload = new Uint8Array(input.payload);
        const envelope = {
            payload: encodeBase64Std(payload),
            payloadType: input.payloadType,
            signatures: [{ sig: encodeBase64Std(signature), keyid: '' }],
        };
        const tlogEntries: unknown[] = [];
        if (logged) {
            const integratedSeconds = integratedTime.getTime() / 1000;
            const canonicalEnvelope = JSON.stringify({
                payload: envelope.payload,
                payloadType: envelope.payloadType,
                signatures: [{ keyid: '', sig: envelope.signatures[0]?.sig }],
            });
            const body = utf8Encode(
                JSON.stringify({
                    apiVersion: '0.0.1',
                    kind: 'dsse',
                    spec: {
                        envelopeHash: { algorithm: 'sha256', value: hex(await sha256(utf8Encode(canonicalEnvelope))) },
                        payloadHash: { algorithm: 'sha256', value: hex(await sha256(payload)) },
                        signatures: [
                            {
                                signature: encodeBase64Std(signature),
                                verifier: encodeBase64Std(utf8Encode(pem(certificate))),
                            },
                        ],
                    },
                }),
            );
            const inclusion = await logInclusion(rekor, body, input.logIndex, integratedSeconds, withPromise);
            tlogEntries.push({
                logIndex: String(input.logIndex),
                logId: { keyId: encodeBase64Std(rekor.keyId) },
                kindVersion: { kind: 'dsse', version: '0.0.1' },
                integratedTime: String(integratedSeconds),
                ...(inclusion.signedEntryTimestamp === undefined
                    ? {}
                    : { inclusionPromise: { signedEntryTimestamp: inclusion.signedEntryTimestamp } }),
                inclusionProof: inclusion.inclusionProof,
                canonicalizedBody: encodeBase64Std(body),
            });
        }
        const rfc3161Timestamps = await Promise.all(
            tsaTimes.map(async (time) => ({
                signedTimestamp: encodeBase64Std(await timestampResponse(tsa, signature, time)),
            })),
        );
        return JSON.stringify({
            mediaType: BUNDLE_MEDIA_TYPE,
            verificationMaterial: {
                certificate: { rawBytes: encodeBase64Std(certificate) },
                tlogEntries,
                timestampVerificationData: { rfc3161Timestamps },
            },
            dsseEnvelope: envelope,
        });
    }

    return Object.freeze({ trustedRoot, attest });
}
