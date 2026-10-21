// Scans bytes for known secrets and for any PEM private key at all. Results name where something was found and in
// which representation, never the bytes themselves, so a failing test can print them as they are.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import type { SecretNeedle } from './secret-forms.ts';
import { readTar } from './tar-reader.ts';

export interface Haystack {
    readonly label: string;
    readonly bytes: Uint8Array;
}

export interface SecretFinding {
    readonly label: string;
    readonly secret: string;
    readonly form: string;
}

/** `type` is the PEM label, e.g. `PRIVATE KEY` or `EC PRIVATE KEY`. */
export type FoundPrivateKey =
    | {
          readonly status: 'parsed';
          readonly label: string;
          readonly type: string;
          readonly keyType: string;
          readonly publicKeySpkiSha256: string;
      }
    | { readonly status: 'encrypted' | 'unparseable'; readonly label: string; readonly type: string };

export interface ContentScan {
    readonly findings: readonly SecretFinding[];
    readonly privateKeys: readonly FoundPrivateKey[];
}

export interface ScanReport extends ContentScan {
    readonly filesScanned: number;
    readonly bytesScanned: number;
}

// The body admits only base64, whitespace, RFC 1421 headers (`Proc-Type`, `DEK-Info`) and JSON-escaped newlines, so a
// lone BEGIN marker in source code never pairs with an END marker further down the file.
const PEM_PRIVATE_KEY = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----([A-Za-z0-9+/=\s:,\\-]*?)-----END \1-----/g;

/** Lowercase hex SHA-256 of a public key's SPKI DER: how a found private key is matched to a certificate. */
export function publicKeySpkiSha256(key: KeyObject): string {
    return createHash('sha256')
        .update(key.export({ format: 'der', type: 'spki' }))
        .digest('hex');
}

function view(bytes: Uint8Array): Buffer {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function findSecretForms(haystack: Haystack, needles: readonly SecretNeedle[]): readonly SecretFinding[] {
    const bytes = view(haystack.bytes);
    return needles
        .filter((candidate) => bytes.includes(view(candidate.bytes)))
        .map(({ secret, form }) => ({ label: haystack.label, secret, form }));
}

export function privateKeysIn(label: string, bytes: Uint8Array): readonly FoundPrivateKey[] {
    const buffer = view(bytes);
    if (!buffer.includes('PRIVATE KEY-----')) return [];
    const found: FoundPrivateKey[] = [];
    for (const [, type = '', body = ''] of buffer.toString('latin1').matchAll(PEM_PRIVATE_KEY)) {
        if (!/[A-Za-z0-9+/]/.test(body)) continue;
        if (type.startsWith('ENCRYPTED ') || /Proc-Type:\s*4,ENCRYPTED/.test(body)) {
            found.push({ status: 'encrypted', label, type });
            continue;
        }
        const lines = body.replace(/\\[nr]|\s/g, '').match(/.{1,64}/g) ?? [];
        const pem = [`-----BEGIN ${type}-----`, ...lines, `-----END ${type}-----`].join('\n');
        let key: KeyObject;
        try {
            key = createPrivateKey(pem);
        } catch {
            found.push({ status: 'unparseable', label, type });
            continue;
        }
        found.push({
            status: 'parsed',
            label,
            type,
            keyType: key.asymmetricKeyType ?? 'unknown',
            publicKeySpkiSha256: publicKeySpkiSha256(createPublicKey(key)),
        });
    }
    return found;
}

function scanBytes(haystack: Haystack, needles: readonly SecretNeedle[]): ContentScan {
    return { findings: findSecretForms(haystack, needles), privateKeys: privateKeysIn(haystack.label, haystack.bytes) };
}

/** For text outside a filesystem: environment variables, inspect JSON. */
export function scanText(label: string, text: string, needles: readonly SecretNeedle[]): ContentScan {
    return scanBytes({ label, bytes: Buffer.from(text, 'utf8') }, needles);
}

/** Scans every regular file of a tar stream, labelled `${name}:${path}`. */
export async function scanTarStream(
    name: string,
    source: AsyncIterable<Uint8Array>,
    needles: readonly SecretNeedle[],
): Promise<ScanReport> {
    const findings: SecretFinding[] = [];
    const privateKeys: FoundPrivateKey[] = [];
    let filesScanned = 0;
    let bytesScanned = 0;
    for await (const entry of readTar(source)) {
        if (entry.type !== 'file') continue;
        const scan = scanBytes({ label: `${name}:${entry.path}`, bytes: entry.content }, needles);
        findings.push(...scan.findings);
        privateKeys.push(...scan.privateKeys);
        filesScanned += 1;
        bytesScanned += entry.size;
    }
    return { findings, privateKeys, filesScanned, bytesScanned };
}
