// Every representation a secret could take on disk or in the environment, as byte needles for an exact search.
// Needle bytes are secret: they must never reach a log, an error message or a test report.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export interface SecretNeedle {
    /** Which secret, e.g. `engine identity key`. */
    readonly secret: string;
    /** Which representation of it, e.g. `seed, base64url (JWK d)`. */
    readonly form: string;
    readonly bytes: Uint8Array;
}

/** Shorter needles could match by chance in a large filesystem. */
export const MIN_NEEDLE_BYTES = 16;

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/;
const PEM_LINE_CHARS = 64;

/** A needle for any other secret, such as a token from the environment; refuses one too short to be unique. */
export function secretNeedle(secret: string, form: string, bytes: Uint8Array): SecretNeedle {
    if (bytes.length < MIN_NEEDLE_BYTES) {
        throw new RangeError(`${secret}, ${form}: needle of ${String(bytes.length)} bytes is too short`);
    }
    return { secret, form, bytes };
}

function ascii(value: string): Uint8Array {
    return Buffer.from(value, 'latin1');
}

/**
 * The DER, its base64 on one line, and the first line of its 64-column PEM rendering. Line breaks interrupt the full
 * base64 in a PEM file, but the first line is the same in every 64-column rendering, whatever the line endings and
 * even inside a bundle or a JSON string with escaped newlines; its 48 bytes already reach into what makes the value
 * unique (a certificate's serial, a key's private part).
 */
function derForms(secret: string, name: string, der: Uint8Array): readonly SecretNeedle[] {
    const base64 = Buffer.from(der).toString('base64');
    return [
        secretNeedle(secret, `${name} DER`, der),
        secretNeedle(secret, `${name} DER, base64`, ascii(base64.replace(/=+$/, ''))),
        secretNeedle(secret, `${name} PEM, first line`, ascii(base64.slice(0, PEM_LINE_CHARS))),
    ];
}

/** Base64 without padding, so the needle matches padded and unpadded copies alike. */
function rawForms(secret: string, name: string, raw: Uint8Array): readonly SecretNeedle[] {
    const bytes = Buffer.from(raw);
    return [
        secretNeedle(secret, name, raw),
        secretNeedle(secret, `${name}, base64url (JWK d)`, ascii(bytes.toString('base64url'))),
        secretNeedle(secret, `${name}, base64`, ascii(bytes.toString('base64').replace(/=+$/, ''))),
        secretNeedle(secret, `${name}, hex`, ascii(bytes.toString('hex'))),
    ];
}

function pemBlock(secret: string, pem: string): Uint8Array {
    const block = PEM_BLOCK.exec(pem);
    if (block === null) throw new Error(`${secret}: no PEM block`);
    return ascii(block[0]);
}

function parsePrivateKey(secret: string, pem: string, expected: string): KeyObject {
    let key: KeyObject;
    try {
        key = createPrivateKey(pem);
    } catch {
        // Not chained as the cause: OpenSSL's message is not ours to vouch for, and must not echo key material.
        throw new Error(`${secret}: not a PEM private key`);
    }
    const actual = key.asymmetricKeyDetails?.namedCurve ?? key.asymmetricKeyType;
    if (actual !== expected) throw new Error(`${secret}: expected a ${expected} key`);
    return key;
}

function jwkPrivate(key: KeyObject): Uint8Array {
    const { d } = key.export({ format: 'jwk' });
    if (d === undefined) throw new Error('JWK export has no private component');
    return Buffer.from(d, 'base64url');
}

/** Forms of an Ed25519 private key given as PEM, such as the engine identity key file. */
export function ed25519PrivateKeyForms(secret: string, pkcs8Pem: string): readonly SecretNeedle[] {
    const key = parsePrivateKey(secret, pkcs8Pem, 'ed25519');
    return [
        secretNeedle(secret, 'PEM', pemBlock(secret, pkcs8Pem)),
        ...derForms(secret, 'PKCS#8', key.export({ format: 'der', type: 'pkcs8' })),
        ...rawForms(secret, 'seed', jwkPrivate(key)),
    ];
}

/** Forms of an ECDSA P-256 private key given as PEM, such as the dev CA key. */
export function ecPrivateKeyForms(secret: string, pem: string): readonly SecretNeedle[] {
    const key = parsePrivateKey(secret, pem, 'prime256v1');
    return [
        secretNeedle(secret, 'PEM', pemBlock(secret, pem)),
        ...derForms(secret, 'PKCS#8', key.export({ format: 'der', type: 'pkcs8' })),
        ...derForms(secret, 'SEC1', key.export({ format: 'der', type: 'sec1' })),
        ...rawForms(secret, 'scalar', jwkPrivate(key)),
    ];
}

function rawPublicKey(secret: string, publicKey: KeyObject): Uint8Array {
    const { x, y, n } = publicKey.export({ format: 'jwk' });
    const type = publicKey.asymmetricKeyType;
    if (type === 'ec' && x !== undefined && y !== undefined) {
        return Buffer.concat([Buffer.from([0x04]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]);
    }
    if (type === 'ed25519' && x !== undefined) return Buffer.from(x, 'base64url');
    if (type === 'rsa' && n !== undefined) return Buffer.from(n, 'base64url');
    throw new Error(`${secret}: unsupported public key type ${String(type)}`);
}

/**
 * Forms of a certificate, plus its public key as SPKI DER and as the raw key a private key file embeds next to the
 * private part (OpenSSL-style EC keys carry the uncompressed point). The raw form is how a DER copy of a key that only
 * ever lives in the engine's memory is detected; PEM copies are caught by comparing SPKI hashes instead.
 */
export function certificateForms(secret: string, der: Uint8Array): readonly SecretNeedle[] {
    const publicKey = new X509Certificate(der).publicKey;
    return [
        ...derForms(secret, 'certificate', der),
        secretNeedle(secret, 'public key, SPKI DER', publicKey.export({ format: 'der', type: 'spki' })),
        secretNeedle(secret, 'public key, raw', rawPublicKey(secret, publicKey)),
    ];
}
