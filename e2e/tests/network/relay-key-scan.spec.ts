import { X509Certificate, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tlsPeerCertificate } from '../../src/certificates.ts';
import type { ComposeControl } from '../../src/compose.ts';
import { expect, test } from '../../src/fixtures.ts';
import type { ContentScan, FoundPrivateKey, SecretFinding } from '../../src/key-scan/scan.ts';
import { publicKeySpkiSha256, scanTarStream, scanText } from '../../src/key-scan/scan.ts';
import type { SecretNeedle } from '../../src/key-scan/secret-forms.ts';
import { certificateForms, ecPrivateKeyForms, ed25519PrivateKeyForms } from '../../src/key-scan/secret-forms.ts';
import { HTTPS_PORT, MOUNTS, RELAYS, relayCertificateFile } from '../../src/stack.ts';

const RELAY = 'relay-a';
const ENGINE = 'mock-engine';
const GNUTLS_LIBRARY = /^relay-a:\/:usr\/lib\/[\w-]+\/libgnutls\.so\.[\d.]+$/;

/** A file only the mock engine can read. Never printed: a failed read reports the exit code and nothing else. */
async function engineFile(compose: ComposeControl, path: string): Promise<string> {
    const result = await compose.exec(ENGINE, ['cat', path]);
    if (result.exitCode !== 0) throw new Error(`reading ${path} in ${ENGINE} exited with ${String(result.exitCode)}`);
    return result.stdout;
}

/*
 * The relay must hold nothing that could decrypt or impersonate the engine. The test takes the engine's secrets from
 * the engine itself (its identity key and the dev CA key, which mints its TLS certificates) and its live certificate
 * from a TLS handshake, then searches everything relay-a has: its root filesystem, every mount, its configured and its
 * running environment, and its container configuration. The engine's TLS key exists only in the engine's memory, so
 * it is caught by its public half: any private key found on the relay is matched against the engine certificate's
 * public key, and only relay-a's own key may be there. Findings name the place and the form, never the bytes.
 */
test('relay-a holds no engine key or certificate, and no private key but its own', async ({
    compose,
    engineHost,
    caCertificatePem,
}) => {
    test.setTimeout(180_000);
    const relayA = RELAYS.find((relay) => relay.service === RELAY);
    if (relayA === undefined) throw new Error('the stack has no relay-a');

    const engineCertificate = await tlsPeerCertificate({
        address: relayA.ip,
        port: HTTPS_PORT,
        servername: engineHost,
        ca: caCertificatePem,
    });
    const identityKey = await engineFile(compose, '/engine/engine-key.pem');
    const devCaKey = await engineFile(compose, '/engine/dev-ca/ca-key.pem');
    const needles: readonly SecretNeedle[] = [
        ...ed25519PrivateKeyForms('engine identity key', identityKey),
        ...ecPrivateKeyForms('dev CA key', devCaKey),
        ...certificateForms('engine TLS certificate', engineCertificate.raw),
    ];
    const engineSpkis = new Set([
        publicKeySpkiSha256(createPublicKey(identityKey)),
        publicKeySpkiSha256(createPublicKey(devCaKey)),
        publicKeySpkiSha256(engineCertificate.publicKey),
    ]);

    const inspection = await compose.inspect(RELAY);
    const scans: ContentScan[] = [];
    let filesScanned = 0;
    const root = await scanTarStream(`${RELAY}:/`, await compose.exportFilesystem(RELAY), needles);
    scans.push(root);
    filesScanned += root.filesScanned;
    for (const mount of inspection.mounts) {
        const scan = await scanTarStream(
            `${RELAY}:${mount.destination}`,
            await compose.archive(RELAY, mount.destination),
            needles,
        );
        scans.push(scan);
        filesScanned += scan.filesScanned;
    }
    scans.push(scanText(`${RELAY} configured environment`, inspection.env.join('\n'), needles));
    scans.push(
        scanText(
            `${RELAY} command and labels`,
            JSON.stringify([inspection.entrypoint, inspection.cmd, inspection.labels]),
            needles,
        ),
    );
    const environ = await compose.exec(RELAY, ['cat', '/proc/1/environ']);
    expect(environ.exitCode).toBe(0);
    scans.push(scanText(`${RELAY} running environment`, environ.stdout.replaceAll('\0', '\n'), needles));
    console.log(
        `key scan: ${String(filesScanned)} files in ${RELAY} (root and ${String(inspection.mounts.length)} mounts), ` +
            `${String(needles.length)} forms of 3 engine secrets`,
    );
    expect(filesScanned).toBeGreaterThan(1_000);

    const findings: SecretFinding[] = scans.flatMap((scan) => scan.findings);
    expect(findings).toEqual([]);

    const ownKey = new X509Certificate(await readFile(join(MOUNTS.public, relayCertificateFile(relayA)))).publicKey;
    // Text that only looks like a PEM key (examples in npm's docs) does not parse as one, and a block no key parser
    // accepts is not a key anyone can use: counted, not judged. GnuTLS compiles its self-test keys into the library
    // the base image ships; they are the same in every copy of it, and still must not be the engine's.
    const privateKeys: FoundPrivateKey[] = scans.flatMap((scan) => scan.privateKeys);
    const usable = privateKeys.filter((key) => key.status !== 'unparseable');
    const libraryKeys = usable.filter((key) => GNUTLS_LIBRARY.test(key.label));
    console.log(
        `key scan: ${String(libraryKeys.length)} GnuTLS self-test keys, ` +
            `${String(privateKeys.length - usable.length)} key-like blocks that are not keys`,
    );
    expect(
        usable
            .filter((key) => key.status !== 'parsed' || engineSpkis.has(key.publicKeySpkiSha256))
            .map((key) => key.label),
        'keys that are encrypted or belong to the engine',
    ).toEqual([]);
    expect(
        usable
            .filter((key) => !GNUTLS_LIBRARY.test(key.label))
            .map((key) => ({ label: key.label, spki: key.status === 'parsed' ? key.publicKeySpkiSha256 : null })),
        "relay-a's own TLS key is the only private key it holds",
    ).toEqual([{ label: `${RELAY}:/relay-key:relay-key/key.pem`, spki: publicKeySpkiSha256(ownKey) }]);
    expect(publicKeySpkiSha256(engineCertificate.publicKey)).not.toBe(publicKeySpkiSha256(ownKey));
});
