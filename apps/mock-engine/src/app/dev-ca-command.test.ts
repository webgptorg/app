import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hostname as HostnameSchema } from '@ptbk/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DevCaError, LEAF_LIFETIME_MS, inspectDevCaCertificate } from '../adapters/dev-ca';
import { createFakeClock } from '../testing/fake-clock';
import { createMemoryLogger } from '../testing/memory-logger';
import type { DevCaConfig } from './config';
import { ConfigError, parseDevCaConfig } from './config';
import { DEV_CA_USAGE, DevCaUsageError, parseDevCaCommand, runDevCaCommand } from './dev-ca-command';

const START_MS = Date.UTC(2026, 9, 20, 12, 0, 0);

let directory: string;
let config: DevCaConfig;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dev-ca-command-'));
    config = {
        dataDir: join(directory, 'data'),
        engineDomain: HostnameSchema.parse('engine.test'),
        devCaDomains: [HostnameSchema.parse('ptbk.test')],
    };
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

function deps() {
    return { clock: createFakeClock(START_MS), logger: createMemoryLogger() };
}

describe('parseDevCaCommand', () => {
    it('ensures the CA without arguments and issues with files and hostnames', () => {
        expect(parseDevCaCommand([])).toEqual({ kind: 'ensure' });
        expect(parseDevCaCommand(['issue', 'c.pem', 'k.pem', 'Relay-A.ptbk.test'])).toEqual({
            kind: 'issue',
            certFile: 'c.pem',
            keyFile: 'k.pem',
            hostnames: ['relay-a.ptbk.test'],
        });
    });

    it('refuses anything else with the usage or the position of the bad hostname', () => {
        for (const args of [['create'], ['issue'], ['issue', 'c.pem', 'k.pem']]) {
            expect(() => parseDevCaCommand(args)).toThrow(new DevCaUsageError(DEV_CA_USAGE));
        }
        expect(() => parseDevCaCommand(['issue', 'c.pem', 'k.pem', 'relay-a.ptbk.test', '127.0.0.1'])).toThrow(
            'hostname 2 is not a hostname',
        );
        const many = Array.from({ length: 17 }, (_, index) => `r${String(index)}.ptbk.test`);
        expect(() => parseDevCaCommand(['issue', 'c.pem', 'k.pem', ...many])).toThrow('at most 16 hostnames');
    });
});

describe('parseDevCaConfig', () => {
    it('reads the data directory, the engine domain and the extra CA domains, ignoring other settings', () => {
        expect(
            parseDevCaConfig({
                PTBK_DATA_DIR: '/data',
                PTBK_ENGINE_DOMAIN: 'engine.test',
                MOCK_DEV_CA_DOMAINS: 'ptbk.test, proxy.test',
                PTBK_RELAYS: 'not a url',
            }),
        ).toEqual({ dataDir: '/data', engineDomain: 'engine.test', devCaDomains: ['ptbk.test', 'proxy.test'] });
        expect(parseDevCaConfig({ PTBK_DATA_DIR: '/data', PTBK_ENGINE_DOMAIN: 'engine.test' }).devCaDomains).toEqual(
            [],
        );
    });

    it('names the setting without its value', () => {
        expect(() =>
            parseDevCaConfig({ PTBK_DATA_DIR: '/data', PTBK_ENGINE_DOMAIN: 'engine.test', MOCK_DEV_CA_DOMAINS: 'a b' }),
        ).toThrow(new ConfigError(['MOCK_DEV_CA_DOMAINS: entry 1 must be a hostname']));
    });
});

describe('runDevCaCommand', () => {
    it('creates the constrained CA the engine loads, and reuses it on the next run', async () => {
        const first = await runDevCaCommand({ kind: 'ensure' }, config, deps());
        expect(first).toEqual({
            certificateFile: join(config.dataDir, 'dev-ca', 'ca-cert.pem'),
            keyFile: join(config.dataDir, 'dev-ca', 'ca-key.pem'),
            permittedDomains: ['engine.test', 'ptbk.test'],
        });
        const certificate = new X509Certificate(await readFile(first.certificateFile));
        expect(inspectDevCaCertificate(certificate)).toEqual({
            kind: 'ok',
            permittedDomains: ['engine.test', 'ptbk.test'],
        });
        expect((await stat(first.keyFile)).mode & 0o777).toBe(0o600);

        await runDevCaCommand({ kind: 'ensure' }, config, deps());
        expect(new X509Certificate(await readFile(first.certificateFile)).fingerprint256).toBe(
            certificate.fingerprint256,
        );
    });

    it('issues a leaf for another dev service that verifies against the CA, with a private key file', async () => {
        const certFile = join(directory, 'relay.pem');
        const keyFile = join(directory, 'relay-key.pem');
        const hostnames = [HostnameSchema.parse('relay-a.ptbk.test')];
        const report = await runDevCaCommand({ kind: 'issue', certFile, keyFile, hostnames }, config, deps());
        expect(report).toEqual({
            certificateFile: certFile,
            keyFile,
            hostnames,
            notAfter: new Date(START_MS + LEAF_LIFETIME_MS).toISOString(),
        });

        const ca = new X509Certificate(await readFile(join(config.dataDir, 'dev-ca', 'ca-cert.pem')));
        const leaf = new X509Certificate(await readFile(certFile));
        expect(leaf.verify(ca.publicKey)).toBe(true);
        expect(leaf.subjectAltName).toBe('DNS:relay-a.ptbk.test');
        expect(leaf.checkPrivateKey(createPrivateKey(await readFile(keyFile)))).toBe(true);
        expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
        expect((await stat(certFile)).mode & 0o777).toBe(0o644);
    });

    it('never issues for an engine hostname or outside MOCK_DEV_CA_DOMAINS', async () => {
        const issue = (name: string) =>
            runDevCaCommand(
                {
                    kind: 'issue',
                    certFile: join(directory, 'c.pem'),
                    keyFile: join(directory, 'k.pem'),
                    hostnames: [HostnameSchema.parse('relay-a.ptbk.test'), HostnameSchema.parse(name)],
                },
                config,
                deps(),
            );
        await expect(issue('abcdefghijklmnopqrstuvwxyz.engine.test')).rejects.toThrow(
            new DevCaError('hostname 2 is an engine hostname; only the engine issues those'),
        );
        await expect(issue('engine.test')).rejects.toThrow('hostname 2 is an engine hostname');
        await expect(issue('notptbk.test')).rejects.toThrow('hostname 2 is outside MOCK_DEV_CA_DOMAINS');
        await expect(stat(join(directory, 'k.pem'))).rejects.toThrow();
    });
});
