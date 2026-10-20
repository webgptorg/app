// Writes src/release/vectors.json: DSSE envelopes of a regular release, a security release and a revocation list,
// signed with fixed test keys (C-06).
//
//   node packages/protocol/scripts/generate-release-vectors.ts
//
// Deliberately independent of src/: PAE, key IDs, base64 and signatures are built here with Buffer and node:crypto, so
// src/release/vectors.test.ts checks the package against a second implementation.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const sha256 = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

interface TestKey {
    readonly role: string;
    readonly source: string;
    readonly seed: Buffer;
    readonly publicKey: Buffer;
    readonly privateKey: KeyObject;
    readonly keyid: string;
}

// RFC 8032 §7.1 test keys: public, recognisable, and their public keys checkable against the RFC.
function testKey(role: string, source: string, seedHex: string, publicKeyHex: string): TestKey {
    const seed = Buffer.from(seedHex, 'hex');
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    const publicKey = Buffer.from(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32));
    if (hex(publicKey) !== publicKeyHex) throw new Error(`${source}: seed does not give the RFC public key`);
    return { role, source, seed, publicKey, privateKey, keyid: b64url(sha256(publicKey)) };
}

const release = testKey(
    'release',
    'RFC 8032 TEST 1',
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
);
const maintainers = [
    testKey(
        'maintainer-1',
        'RFC 8032 TEST 2',
        '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
        '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    ),
    testKey(
        'maintainer-2',
        'RFC 8032 TEST 3',
        'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
        'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    ),
    testKey(
        'maintainer-3',
        'RFC 8032 TEST SHA(abc)',
        '833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42',
        'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf',
    ),
] as const;
const outsider = testKey(
    'outsider',
    'RFC 8032 TEST 1024',
    'f5e5767cf153319517630f226876b86c8160cc583bc013744c6bf255f5cc0ee5',
    '278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e',
);

function pae(payloadType: string, payload: Buffer): Buffer {
    const type = Buffer.from(payloadType, 'utf8');
    return Buffer.concat([
        Buffer.from(`DSSEv1 ${String(type.length)} `),
        type,
        Buffer.from(` ${String(payload.length)} `),
        payload,
    ]);
}

// The example from the DSSE v1 protocol document, an outside known answer for the encoding.
const dsseSpecExample = { payloadType: 'http://example.com/HelloWorld', payload: 'hello world' };
const dsseSpecPae = 'DSSEv1 29 http://example.com/HelloWorld 11 hello world';
if (pae(dsseSpecExample.payloadType, Buffer.from(dsseSpecExample.payload)).toString() !== dsseSpecPae) {
    throw new Error('PAE disagrees with the DSSE specification example');
}

function envelope(payloadType: string, payloadText: string, signers: readonly TestKey[]) {
    const payload = Buffer.from(payloadText, 'utf8');
    const message = pae(payloadType, payload);
    const signatures = signers.map((key) => {
        const sig = sign(null, message, key.privateKey);
        if (!verify(null, message, createPublicKey(key.privateKey), sig)) throw new Error('signature does not verify');
        return { keyid: key.keyid, sig: b64(sig), sigHex: hex(sig) };
    });
    return {
        payloadType,
        payloadText,
        payloadHex: hex(payload),
        paeHex: hex(message),
        envelope: JSON.stringify({
            payloadType,
            payload: b64(payload),
            signatures: signatures.map(({ keyid, sig }) => ({ keyid, sig })),
        }),
        signatures,
    };
}

const RELEASE = 'application/vnd.ptbk.release+json; v=1';
const REVOCATION = 'application/vnd.ptbk.revocation+json; v=1';

const workflowIdentity = {
    issuer: 'https://token.actions.githubusercontent.com',
    repository: 'webgptorg/app',
    repositoryId: '987654321',
    workflowPath: '.github/workflows/ui-release.yml',
};

const artifactText = 'engine-ui test artifact\n';
const artifactSha256 = hex(sha256(Buffer.from(artifactText)));
const commit = '0123456789abcdef0123456789abcdef01234567';

// Exact payload texts: the bytes are what is signed, so they are written out, never re-serialised.
const regularPayload =
    `{"v":1,"version":"1.8.2","gitTag":"ui-v1.8.2","commit":"${commit}",` +
    `"artifacts":[{"name":"engine-ui.tar.zst","sha256":"${artifactSha256}","kind":"ui"}],` +
    `"kind":"regular","advisory":null,"publishedAt":"2026-10-01T12:00:00Z"}`;
const securityPayload =
    `{"v":1,"version":"1.8.3","gitTag":"ui-v1.8.3","commit":"${commit}",` +
    `"artifacts":[{"name":"engine-ui.tar.zst","sha256":"${artifactSha256}","kind":"ui"}],` +
    `"kind":"security","advisory":"https://ptbk.io/security/2026-001","publishedAt":"2026-10-01T12:00:00Z"}`;
const revocationPayload =
    '{"v":1,"issuedAt":"2026-10-02T00:00:00Z","expiresAt":"2026-10-09T00:00:00Z",' +
    '"revoked":[{"version":"1.8.1","reason":"Rebuild did not reproduce the published hash"}]}';

const regular = envelope(RELEASE, regularPayload, [release]);
const security = envelope(RELEASE, securityPayload, [release, maintainers[0], maintainers[1]]);
const revocations = envelope(REVOCATION, revocationPayload, [release]);

// Validly signed, but each repeats a key, which JSON.parse resolves last-wins and other parsers first-wins.
const duplicateTopLevelPayload = regularPayload.replace('"version":"1.8.2",', '"version":"1.8.2","version":"9.9.9",');
const duplicateEscapedPayload = regularPayload.replace('"kind":"ui"}', '"kind":"ui","\\u006bind":"engine"}');
for (const text of [duplicateTopLevelPayload, duplicateEscapedPayload]) {
    if (text === regularPayload) throw new Error('duplicate-key payload was not built');
}
const duplicateKeys = [
    {
        id: 'top-level-version',
        description: '"version" appears twice at the top level',
        ...envelope(RELEASE, duplicateTopLevelPayload, [release]),
    },
    {
        id: 'escaped-artifact-kind',
        description: 'an artifact repeats "kind", once spelled "\\u006bind"; keys are compared after unescaping',
        ...envelope(RELEASE, duplicateEscapedPayload, [release]),
    },
];

const rawPayloadSignature = sign(null, Buffer.from(regularPayload), release.privateKey);
if (verify(null, pae(RELEASE, Buffer.from(regularPayload)), createPublicKey(release.privateKey), rawPayloadSignature)) {
    throw new Error('a signature over the raw payload must not verify over the PAE');
}

const document = {
    description:
        'Golden vectors for C-06 release log entries and revocation lists (spec Interfaces 5, ADR 0014): DSSE envelopes over exact payload bytes, Ed25519 over the DSSE v1 PAE, keyid = base64url(SHA-256(raw public key)), payload and sig in standard base64 with padding. Hex is lowercase. Generated by packages/protocol/scripts/generate-release-vectors.ts with node:crypto, independently of the package code; PAE, key IDs and base64 were cross-checked with Python 3 standard library and every signature reproduced with OpenSSL 4.0 (`openssl pkeyutl -sign -rawin`).',
    pae: { ...dsseSpecExample, pae: dsseSpecPae, source: 'DSSE v1 protocol specification example' },
    keys: [release, ...maintainers, outsider].map(({ role, source, seed, publicKey, keyid }) => ({
        role,
        source,
        seedHex: hex(seed),
        publicKeyHex: hex(publicKey),
        publicKey: b64url(publicKey),
        keyid,
    })),
    workflowIdentity,
    expectedSubjectAlternativeName: `https://github.com/${workflowIdentity.repository}/${workflowIdentity.workflowPath}@refs/tags/ui-v1.8.2`,
    expectedExtensions: {
        '1.3.6.1.4.1.57264.1.11': 'github-hosted',
        '1.3.6.1.4.1.57264.1.13': commit,
        '1.3.6.1.4.1.57264.1.14': 'refs/tags/ui-v1.8.2',
        '1.3.6.1.4.1.57264.1.15': workflowIdentity.repositoryId,
        '1.3.6.1.4.1.57264.1.20': 'push',
    },
    artifact: { text: artifactText, sha256: artifactSha256 },
    regular,
    security,
    revocations,
    duplicateKeys: {
        description:
            'Release payloads signed by the release key that must still be refused (invalid-entry): an object at any depth repeats a key.',
        vectors: duplicateKeys,
    },
    signatureOverRawPayload: {
        description: 'The release key over the regular payload bytes instead of their PAE; must not verify.',
        envelope: JSON.stringify({
            payloadType: RELEASE,
            payload: b64(Buffer.from(regularPayload)),
            signatures: [{ keyid: release.keyid, sig: b64(rawPayloadSignature) }],
        }),
    },
};

writeFileSync(
    join(import.meta.dirname, '..', 'src', 'release', 'vectors.json'),
    `${JSON.stringify(document, null, 2)}\n`,
);
