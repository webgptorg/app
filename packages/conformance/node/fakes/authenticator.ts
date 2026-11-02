import { encodeBase64Url } from '@ptbk/protocol';

/**
 * A WebAuthn authenticator in software for the join checks: ES256, `none` attestation, user present and verified. It
 * builds the exact bytes a browser and a platform authenticator would, so the engine's real verification runs on them.
 */

type CborValue = number | string | Uint8Array | ReadonlyMap<CborValue, CborValue>;

function cborHead(major: number, length: number): Uint8Array {
    if (length < 24) return Uint8Array.of((major << 5) | length);
    if (length < 0x100) return Uint8Array.of((major << 5) | 24, length);
    if (length < 0x10000) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
    throw new RangeError('the authenticator encodes nothing this long');
}

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** Just enough CBOR (RFC 8949) for an attestation object and a COSE key: small integers, strings, bytes and maps. */
function cbor(value: CborValue): Uint8Array {
    if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
    if (typeof value === 'string') {
        const bytes = new TextEncoder().encode(value);
        return concat(cborHead(3, bytes.length), bytes);
    }
    if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
    const entries = [...value].flatMap(([key, item]) => [cbor(key), cbor(item)]);
    return concat(cborHead(5, value.size), ...entries);
}

const FLAGS_PRESENT_VERIFIED_ATTESTED = 0x01 | 0x04 | 0x40;

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export interface RegistrationOptionsJson {
    readonly challenge: string;
    readonly rp: { readonly id?: string };
}

function isRegistrationOptions(value: unknown): value is RegistrationOptionsJson {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as { challenge?: unknown; rp?: unknown };
    return typeof candidate.challenge === 'string' && typeof candidate.rp === 'object' && candidate.rp !== null;
}

/** A new passkey for `options` at `origin`, as `startRegistration` would return it; throws on options it cannot use. */
export async function createPasskey(options: unknown, origin: string): Promise<unknown> {
    if (!isRegistrationOptions(options)) throw new Error('the engine sent no usable registration options');
    const rpId = options.rp.id ?? new URL(origin).hostname;
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const credentialId = crypto.getRandomValues(new Uint8Array(16));
    const cosePublicKey = cbor(
        new Map<CborValue, CborValue>([
            [1, 2],
            [3, -7],
            [-1, 1],
            [-2, raw.slice(1, 33)],
            [-3, raw.slice(33, 65)],
        ]),
    );
    const authData = concat(
        await sha256(new TextEncoder().encode(rpId)),
        Uint8Array.of(FLAGS_PRESENT_VERIFIED_ATTESTED),
        new Uint8Array(4),
        new Uint8Array(16),
        Uint8Array.of(0, credentialId.length),
        credentialId,
        cosePublicKey,
    );
    const attestationObject = cbor(
        new Map<CborValue, CborValue>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData],
        ]),
    );
    const clientData = new TextEncoder().encode(
        JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }),
    );
    const id = encodeBase64Url(credentialId);
    return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
            clientDataJSON: encodeBase64Url(clientData),
            attestationObject: encodeBase64Url(attestationObject),
            transports: ['internal'],
        },
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
    };
}
