// Runs once per stack, in the init container, before anything else starts: provisions every key, certificate and
// the registry into fresh volumes. Nothing it writes is committed, and it prints only public facts.
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmod, chown, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
    ENGINE_DOMAIN,
    MOUNTS,
    OUR_DOMAIN,
    PUBLIC_FILES,
    RELAYS,
    RELEASE_STORE,
    SERVICE_UID,
    UI_RELEASES,
    relayCertificateFile,
} from '../src/stack.ts';
import { parseIdentityReport, staticRegistry } from './registry.ts';

const MOCK_ENGINE_DIR = '/repo/apps/mock-engine';
const KEY_FILE = 'key.pem';
const PEBBLE_MINICA_SOURCE = '/pebble/minica.pem';

const run = promisify(execFile);

/** The mock engine's own CLIs, so the identity and the CA are exactly what the engine itself would create. */
async function mockEngineCli(args: readonly string[]): Promise<unknown> {
    const { stdout } = await run('bun', ['run', '--silent', ...args], {
        cwd: MOCK_ENGINE_DIR,
        env: {
            PATH: process.env['PATH'],
            HOME: '/tmp',
            PTBK_DATA_DIR: MOUNTS.engine,
            PTBK_ENGINE_DOMAIN: ENGINE_DOMAIN,
            MOCK_DEV_CA_DOMAINS: OUR_DOMAIN,
        },
    });
    return JSON.parse(stdout) as unknown;
}

function relayKeyDirectory(hostname: string): string {
    return join(MOUNTS.relayKeys, hostname);
}

/** Volumes start out root-owned; hand them to the services' user, private ones at 0700. */
async function prepareVolumes(): Promise<void> {
    const volumes: readonly [string, number][] = [
        [MOUNTS.public, 0o755],
        [MOUNTS.engine, 0o700],
        [MOUNTS.releases, 0o755],
        [MOUNTS.releaseStoreKey, 0o700],
        ...RELAYS.map((relay): [string, number] => [relayKeyDirectory(relay.hostname), 0o700]),
    ];
    for (const [path, mode] of volumes) {
        await chown(path, SERVICE_UID, SERVICE_UID);
        await chmod(path, mode);
    }
    if (process.setgid === undefined || process.setuid === undefined) throw new Error('init runs only on POSIX');
    process.setgid(SERVICE_UID);
    process.setuid(SERVICE_UID);
}

function caCertificateFile(report: unknown): string {
    const file = (report as { certificateFile?: unknown } | null)?.certificateFile;
    if (typeof file !== 'string') throw new Error('dev-ca report has no certificateFile');
    return file;
}

async function writePublic(name: string, content: string): Promise<string> {
    const path = join(MOUNTS.public, name);
    await writeFile(path, content, { mode: 0o644 });
    return path;
}

async function main(): Promise<void> {
    await prepareVolumes();

    const identity = parseIdentityReport(await mockEngineCli(['identity']), ENGINE_DOMAIN);
    const caFile = join(MOUNTS.public, PUBLIC_FILES.caCertificate);
    await copyFile(caCertificateFile(await mockEngineCli(['dev-ca'])), caFile);
    await chmod(caFile, 0o644);

    for (const relay of RELAYS) {
        await mockEngineCli([
            'dev-ca',
            'issue',
            join(MOUNTS.public, relayCertificateFile(relay)),
            join(relayKeyDirectory(relay.hostname), KEY_FILE),
            relay.hostname,
        ]);
    }
    await mockEngineCli([
        'dev-ca',
        'issue',
        join(MOUNTS.public, PUBLIC_FILES.releaseStoreCertificate),
        join(MOUNTS.releaseStoreKey, KEY_FILE),
        RELEASE_STORE.hostname,
    ]);
    // Signs and publishes the UI bundles with release keys that exist only inside this one command.
    const releases = await mockEngineCli([
        'ui-test-release',
        MOUNTS.releases,
        MOUNTS.public,
        join(MOUNTS.uiBundles, UI_RELEASES.installed),
        join(MOUNTS.uiBundles, UI_RELEASES.tampered),
    ]);
    // Public by nature: the root of Pebble's own HTTPS listeners, from its image (stack.Dockerfile).
    await writePublic(PUBLIC_FILES.pebbleMinica, await readFile(PEBBLE_MINICA_SOURCE, 'utf8'));
    await writePublic(PUBLIC_FILES.engineIdentity, `${JSON.stringify(identity, null, 2)}\n`);
    await writePublic(PUBLIC_FILES.registry, `${JSON.stringify(staticRegistry(identity), null, 2)}\n`);

    const fingerprint = new X509Certificate(await readFile(caFile)).fingerprint256;
    process.stdout.write(`init: engine ${identity.engineId}, dev CA SHA-256 ${fingerprint}\n`);
    process.stdout.write(`init: UI releases ${JSON.stringify(releases)}\n`);
}

try {
    await main();
} catch (error) {
    process.stderr.write(`init failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
}
