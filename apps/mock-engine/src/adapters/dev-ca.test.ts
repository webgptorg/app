import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:tls';
import { inspect } from 'node:util';

import type { Hostname } from '@ptbk/protocol';
import { Hostname as HostnameSchema } from '@ptbk/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeClock } from '../testing/fake-clock';
import { createMemoryLogger } from '../testing/memory-logger';
import { createTestCa } from '../testing/test-pki';
import type { DevCa } from './dev-ca';
import {
    DEV_CA_CERT_FILE,
    DEV_CA_DIRECTORY,
    DEV_CA_KEY_FILE,
    DEV_CA_LIFETIME_MS,
    DevCaError,
    LEAF_LIFETIME_MS,
    LEAF_RENEW_AFTER_MS,
    createDevCa,
    createDevCaCertificateSource,
    inspectDevCaCertificate,
    issueLeaf,
    loadOrCreateDevCa,
} from './dev-ca';
import {
    GENERAL_NAME,
    KEY_USAGE,
    OID,
    basicConstraints,
    certificateExtensions,
    extension,
    keyUsage,
    signCertificate,
} from './x509/certificate';
import type { DerNode } from './x509/der';
import { TAG, bitString, boolean, childrenOf, constructedContextTag, contextTag, sequence, tlv } from './x509/der';

const ENGINE_DOMAIN = HostnameSchema.parse('engine.test');
const E2E_DOMAIN = HostnameSchema.parse('ptbk.test');
const ENGINE_HOST = HostnameSchema.parse('abcdefghijklmnopqrstuvwxyz.engine.test');
const CUSTOM_HOST = HostnameSchema.parse('agents.ptbk.test');
// A whole second, so certificate times (whole seconds) equal the clock exactly.
const START_MS = Date.UTC(2026, 9, 20, 12, 0, 0);

function required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('missing');
    return value;
}

/** How a value shows up when something interpolates it into a string, e.g. a careless log line. */
function printed(value: unknown): string {
    return String(value);
}

function keyBody(pem: string): string {
    return pem.split('\n').slice(1, -2).join('');
}

function caKeyPem(ca: DevCa): string {
    return ca.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

describe('createDevCa', () => {
    it('constrains names in a critical extension: permitted DNS subtrees as configured, every IP excluded', () => {
        const ca = createDevCa([ENGINE_DOMAIN, E2E_DOMAIN], createFakeClock(START_MS));
        const extensions = certificateExtensions(ca.certificate.raw);

        const constraints = required(extensions.get(OID.nameConstraints));
        expect(constraints.critical).toBe(true);
        const [permitted, excluded, ...rest] = childrenOf(constraints.value);
        expect(rest).toEqual([]);
        expect(permitted?.tag).toBe(constructedContextTag(0));
        expect(excluded?.tag).toBe(constructedContextTag(1));
        const bases = (node: DerNode | undefined) =>
            childrenOf(required(node)).map((subtree) => {
                const parts = childrenOf(subtree);
                // minimum and maximum are absent: DEFAULT 0 and unbounded.
                expect(parts).toHaveLength(1);
                return parts[0];
            });
        expect(bases(permitted).map((base) => [base?.tag, base?.content.toString('ascii')])).toEqual([
            [contextTag(GENERAL_NAME.dNSName), 'engine.test'],
            [contextTag(GENERAL_NAME.dNSName), 'ptbk.test'],
        ]);
        expect(bases(excluded).map((base) => [base?.tag, base?.content.toString('hex')])).toEqual([
            [contextTag(GENERAL_NAME.iPAddress), '00'.repeat(8)],
            [contextTag(GENERAL_NAME.iPAddress), '00'.repeat(32)],
        ]);

        const basic = required(extensions.get(OID.basicConstraints));
        expect(basic.critical).toBe(true);
        const [cA, pathLen, ...more] = childrenOf(basic.value);
        expect(more).toEqual([]);
        expect([cA?.tag, cA?.content.toString('hex')]).toEqual([TAG.boolean, 'ff']);
        expect([pathLen?.tag, pathLen?.content.toString('hex')]).toEqual([TAG.integer, '00']);

        const usage = extensions.get(OID.keyUsage);
        expect(usage?.critical).toBe(true);
        // One unused bit, then keyCertSign (bit 5) and cRLSign (bit 6) only.
        expect([usage?.value.tag, usage?.value.content.toString('hex')]).toEqual([TAG.bitString, '0106']);

        expect(ca.certificate.ca).toBe(true);
        expect(ca.certificate.checkIssued(ca.certificate)).toBe(true);
        expect(ca.certificate.verify(ca.certificate.publicKey)).toBe(true);
        expect(ca.certificate.validFromDate.getTime()).toBe(START_MS);
        expect(ca.certificate.validToDate.getTime()).toBe(START_MS + DEV_CA_LIFETIME_MS);
        expect(ca.permittedDomains).toEqual(['engine.test', 'ptbk.test']);
        expect(inspectDevCaCertificate(ca.certificate)).toEqual({
            kind: 'ok',
            permittedDomains: ['engine.test', 'ptbk.test'],
        });
    });

    it('needs at least one permitted domain', () => {
        expect(() => createDevCa([], createFakeClock(START_MS))).toThrow(RangeError);
    });

    it('never prints its key', () => {
        const ca = createDevCa([ENGINE_DOMAIN], createFakeClock(START_MS));
        const body = keyBody(caKeyPem(ca));
        for (const text of [JSON.stringify(ca), inspect(ca, { depth: 5 }), printed(ca.privateKey)]) {
            expect(text).not.toContain('PRIVATE KEY');
            expect(text).not.toContain(body.slice(0, 32));
        }
    });
});

describe('issueLeaf', () => {
    it('issues a 7-day serverAuth leaf from the injected clock that verifies against the CA', () => {
        const clock = createFakeClock(START_MS + 499);
        const ca = createDevCa([ENGINE_DOMAIN, E2E_DOMAIN], clock);
        const leaf = issueLeaf(ca, [ENGINE_HOST, CUSTOM_HOST], clock);
        const certificate = new X509Certificate(leaf.certificatePem);
        expect(certificate.verify(ca.certificate.publicKey)).toBe(true);
        expect(certificate.checkIssued(ca.certificate)).toBe(true);
        expect(certificate.ca).toBe(false);
        expect(certificate.subjectAltName).toBe(`DNS:${ENGINE_HOST}, DNS:${CUSTOM_HOST}`);
        expect(certificate.subject).toBe(`CN=${ENGINE_HOST}`);
        expect(certificate.keyUsage).toEqual([OID.serverAuth]);
        expect(certificate.validFromDate.getTime()).toBe(START_MS);
        expect(certificate.validToDate.getTime() - certificate.validFromDate.getTime()).toBe(LEAF_LIFETIME_MS);
        expect([leaf.notBeforeMs, leaf.notAfterMs]).toEqual([START_MS, START_MS + 7 * 86_400_000]);
        expect(certificate.checkPrivateKey(createPrivateKey(leaf.privateKeyPem.reveal()))).toBe(true);
        const usage = certificateExtensions(certificate.raw).get(OID.keyUsage);
        expect([usage?.critical, usage?.value.content.toString('hex')]).toEqual([true, '0780']);
    });

    it('needs at least one name', () => {
        const clock = createFakeClock(START_MS);
        expect(() => issueLeaf(createDevCa([ENGINE_DOMAIN], clock), [], clock)).toThrow(RangeError);
    });

    it('never prints the leaf key', () => {
        const clock = createFakeClock(START_MS);
        const leaf = issueLeaf(createDevCa([ENGINE_DOMAIN], clock), [ENGINE_HOST], clock);
        const body = keyBody(leaf.privateKeyPem.reveal());
        for (const text of [JSON.stringify(leaf), inspect(leaf, { depth: 5 }), printed(leaf.privateKeyPem)]) {
            expect(text).not.toContain('PRIVATE KEY');
            expect(text).not.toContain(body.slice(0, 32));
        }
    });
});

describe('name constraints under OpenSSL verification', () => {
    const servers: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const close of servers.splice(0)) await close();
    });

    async function serve(certificatePem: string, keyPem: string): Promise<number> {
        const server = createServer({ cert: certificatePem, key: keyPem }, (socket) => socket.end());
        server.on('tlsClientError', () => undefined);
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        servers.push(async () => {
            server.close();
            await once(server, 'close');
        });
        return (server.address() as AddressInfo).port;
    }

    /**
     * Resolves `'ok'` or the client's verification error. Node reports these two OpenSSL errors (X509_V_ERR 47 and 48)
     * with the code `UNSPECIFIED`, so the test reads OpenSSL's message instead.
     */
    function handshake(port: number, ca: string, servername: string | undefined): Promise<string> {
        return new Promise((resolve) => {
            const socket = connect({
                host: '127.0.0.1',
                port,
                ca,
                ...(servername === undefined ? {} : { servername }),
            });
            socket.once('secureConnect', () => {
                socket.destroy();
                resolve('ok');
            });
            socket.once('error', (error: NodeJS.ErrnoException) => {
                socket.destroy();
                resolve(error.message);
            });
        });
    }

    // Real time: OpenSSL checks validity against the system clock.
    function setup() {
        const clock = createFakeClock(Date.now());
        return { clock, ca: createDevCa([ENGINE_DOMAIN, E2E_DOMAIN], clock) };
    }

    it('accepts a leaf inside the permitted domains (control)', async () => {
        const { clock, ca } = setup();
        const leaf = issueLeaf(ca, [ENGINE_HOST], clock);
        const port = await serve(leaf.certificatePem, leaf.privateKeyPem.reveal());
        expect(await handshake(port, ca.certificatePem, ENGINE_HOST)).toBe('ok');
    });

    it('refuses a leaf the CA issued for a name outside the permitted domains', async () => {
        const { clock, ca } = setup();
        const leaf = issueLeaf(ca, ['www.example.com'], clock);
        const port = await serve(leaf.certificatePem, leaf.privateKeyPem.reveal());
        expect(await handshake(port, ca.certificatePem, 'www.example.com')).toBe('permitted subtree violation');
    });

    it('refuses a leaf whose SAN is an IP address, connected to by IP', async () => {
        const { clock, ca } = setup();
        const leaf = issueLeaf(ca, ['127.0.0.1'], clock);
        expect(new X509Certificate(leaf.certificatePem).subjectAltName).toBe('IP Address:127.0.0.1');
        const port = await serve(leaf.certificatePem, leaf.privateKeyPem.reveal());
        expect(await handshake(port, ca.certificatePem, undefined)).toBe('excluded subtree violation');
    });
});

describe('inspectDevCaCertificate', () => {
    it('refuses an unconstrained CA, a leaf and a certificate it cannot decode', () => {
        const unconstrained = new X509Certificate(createTestCa('Unconstrained').certPem);
        expect(inspectDevCaCertificate(unconstrained)).toEqual({ kind: 'invalid' });
        const clock = createFakeClock(START_MS);
        const leaf = issueLeaf(createDevCa([ENGINE_DOMAIN], clock), [ENGINE_HOST], clock);
        expect(inspectDevCaCertificate(new X509Certificate(leaf.certificatePem))).toEqual({ kind: 'invalid' });
        const garbage = { ca: true, raw: Buffer.from('3003020101', 'hex') } as unknown as X509Certificate;
        expect(inspectDevCaCertificate(garbage)).toEqual({ kind: 'invalid' });
    });
});

describe('inspectDevCaCertificate on almost-dev CAs', () => {
    const dns = (name: string) => sequence(tlv(contextTag(GENERAL_NAME.dNSName), Buffer.from(name, 'ascii')));
    const ip = (range: Buffer) => sequence(tlv(contextTag(GENERAL_NAME.iPAddress), range));
    const constraints = (critical: boolean, ...parts: Buffer[]) =>
        extension(OID.nameConstraints, critical, sequence(...parts));
    const permitted = (...subtrees: Buffer[]) => tlv(constructedContextTag(0), ...subtrees);
    const excluded = (...subtrees: Buffer[]) => tlv(constructedContextTag(1), ...subtrees);
    const allIps = excluded(ip(Buffer.alloc(8)), ip(Buffer.alloc(32)));
    const goodBasic = basicConstraints({ ca: true, pathLen: 0 });
    const goodUsage = keyUsage(KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign);
    const goodConstraints = constraints(true, permitted(dns('engine.test')), allIps);

    function caWith(extensions: readonly Buffer[]): X509Certificate {
        const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        return new X509Certificate(
            signCertificate({
                subject: 'Almost',
                issuer: 'Almost',
                notBefore: new Date(START_MS),
                notAfter: new Date(START_MS + DEV_CA_LIFETIME_MS),
                publicKey: keys.publicKey,
                issuerKey: keys.privateKey,
                extensions,
            }),
        );
    }

    it('accepts the hand-built equivalent of createDevCa (control)', () => {
        expect(inspectDevCaCertificate(caWith([goodBasic, goodUsage, goodConstraints]))).toEqual({
            kind: 'ok',
            permittedDomains: ['engine.test'],
        });
    });

    it.each([
        ['pathLen 1', [basicConstraints({ ca: true, pathLen: 1 }), goodUsage, goodConstraints]],
        ['no pathLen', [extension(OID.basicConstraints, true, sequence(boolean(true))), goodUsage, goodConstraints]],
        [
            'digitalSignature as well',
            [
                goodBasic,
                keyUsage(KEY_USAGE.digitalSignature, KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign),
                goodConstraints,
            ],
        ],
        [
            'non-critical key usage',
            [goodBasic, extension(OID.keyUsage, false, bitString(Buffer.of(0x06), 1)), goodConstraints],
        ],
        [
            'non-critical name constraints',
            [goodBasic, goodUsage, constraints(false, permitted(dns('engine.test')), allIps)],
        ],
        ['no name constraints', [goodBasic, goodUsage]],
        ['no excluded subtrees', [goodBasic, goodUsage, constraints(true, permitted(dns('engine.test')))]],
        ['no permitted subtrees', [goodBasic, goodUsage, constraints(true, allIps)]],
        [
            'only IPv4 excluded',
            [goodBasic, goodUsage, constraints(true, permitted(dns('engine.test')), excluded(ip(Buffer.alloc(8))))],
        ],
        [
            'an IP range permitted',
            [goodBasic, goodUsage, constraints(true, permitted(dns('engine.test'), ip(Buffer.alloc(8))), allIps)],
        ],
        ['no key usage', [goodBasic, goodConstraints]],
    ])('refuses a CA with %s', (_name, extensions) => {
        expect(inspectDevCaCertificate(caWith(extensions))).toEqual({ kind: 'invalid' });
    });
});

describe('createDevCaCertificateSource', () => {
    function setup() {
        const clock = createFakeClock(START_MS);
        const logger = createMemoryLogger();
        const ca = createDevCa([ENGINE_DOMAIN, E2E_DOMAIN], clock);
        const source = createDevCaCertificateSource({ ca, clock, logger });
        let changes = 0;
        source.onChange(() => changes++);
        return { clock, logger, ca, source, changes: () => changes };
    }

    function notAfterOf(source: ReturnType<typeof setup>['source'], hostname: Hostname): number {
        const credentials = source.current(hostname);
        if (credentials === undefined) throw new Error('no credentials');
        return new X509Certificate(credentials.certificateChainPem).validToDate.getTime();
    }

    it('holds nothing until told its hostnames, then one leaf for all of them', () => {
        const { source, changes } = setup();
        expect(source.current(ENGINE_HOST)).toBeUndefined();
        source.addHostnames([ENGINE_HOST]);
        expect(changes()).toBe(1);
        const first = source.current(ENGINE_HOST);
        expect(first).toBeDefined();
        expect(source.current(CUSTOM_HOST)).toBeUndefined();

        source.addHostnames([ENGINE_HOST]);
        expect(changes()).toBe(1);
        expect(source.current(ENGINE_HOST)).toBe(first);

        source.addHostnames([CUSTOM_HOST, ENGINE_HOST]);
        expect(changes()).toBe(2);
        const second = source.current(CUSTOM_HOST);
        expect(second).not.toBe(first);
        expect(source.current(ENGINE_HOST)).toBe(second);
        expect(new X509Certificate(second?.certificateChainPem ?? '').subjectAltName).toBe(
            `DNS:${ENGINE_HOST}, DNS:${CUSTOM_HOST}`,
        );
        source.close();
    });

    it('re-issues when two thirds of the lifetime passed, before expiry, and stops on close', () => {
        const { clock, source, changes, logger } = setup();
        source.addHostnames([ENGINE_HOST]);
        const first = source.current(ENGINE_HOST);
        expect(notAfterOf(source, ENGINE_HOST)).toBe(START_MS + LEAF_LIFETIME_MS);
        expect(clock.pendingTimers()).toBe(1);

        clock.advance(LEAF_RENEW_AFTER_MS - 1);
        expect(source.current(ENGINE_HOST)).toBe(first);
        clock.advance(1);
        expect(changes()).toBe(2);
        expect(source.current(ENGINE_HOST)).not.toBe(first);
        expect(notAfterOf(source, ENGINE_HOST)).toBe(START_MS + LEAF_RENEW_AFTER_MS + LEAF_LIFETIME_MS);
        expect(LEAF_RENEW_AFTER_MS).toBeLessThan(LEAF_LIFETIME_MS);
        expect(clock.pendingTimers()).toBe(1);

        clock.advance(LEAF_RENEW_AFTER_MS);
        expect(changes()).toBe(3);
        expect(logger.entries.filter((entry) => entry.event === 'tls.certificate-issued')).toHaveLength(3);
        expect(logger.entries[0]?.fields).toEqual({
            source: 'dev-ca',
            hostnames: 1,
            notAfter: new Date(START_MS + LEAF_LIFETIME_MS).toISOString(),
        });

        source.close();
        expect(clock.pendingTimers()).toBe(0);
        source.addHostnames([CUSTOM_HOST]);
        expect(changes()).toBe(3);
        expect(clock.pendingTimers()).toBe(0);
    });

    it('lets a listener unsubscribe', () => {
        const { source } = setup();
        let calls = 0;
        const off = source.onChange(() => calls++);
        off();
        source.addHostnames([ENGINE_HOST]);
        expect(calls).toBe(0);
        source.close();
    });

    it('never prints keys in credentials or logs', () => {
        const { source, logger, ca } = setup();
        source.addHostnames([ENGINE_HOST]);
        const credentials = source.current(ENGINE_HOST);
        const leafBody = keyBody(credentials?.privateKeyPem.reveal() ?? '');
        const caBody = keyBody(caKeyPem(ca));
        for (const text of [JSON.stringify(credentials), inspect(credentials, { depth: 5 }), logger.text()]) {
            expect(text).not.toContain('PRIVATE KEY');
            expect(text).not.toContain(leafBody.slice(0, 32));
            expect(text).not.toContain(caBody.slice(0, 32));
        }
        source.close();
    });
});

describe('loadOrCreateDevCa', () => {
    let root: string;
    let dataDir: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'ptbk-dev-ca-'));
        dataDir = join(root, 'data');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    function generated(clock = createFakeClock(START_MS), domains: readonly Hostname[] = [ENGINE_DOMAIN]) {
        const logger = createMemoryLogger();
        return {
            logger,
            load: () => loadOrCreateDevCa({ files: null, dataDir, permittedDomains: domains, clock, logger }),
        };
    }

    async function modeOf(path: string): Promise<number> {
        return (await stat(path)).mode & 0o777;
    }

    async function errorOf(promise: Promise<unknown>): Promise<DevCaError> {
        try {
            await promise;
        } catch (error) {
            if (error instanceof DevCaError) return error;
            throw error;
        }
        throw new Error('expected a DevCaError');
    }

    describe('generated into the data directory', () => {
        it('creates 0600 files in a 0700 directory once, then reloads the same CA', async () => {
            const first = generated();
            const ca = await first.load();
            const directory = join(dataDir, DEV_CA_DIRECTORY);
            expect(await modeOf(dataDir)).toBe(0o700);
            expect(await modeOf(directory)).toBe(0o700);
            expect(await modeOf(join(directory, DEV_CA_CERT_FILE))).toBe(0o600);
            expect(await modeOf(join(directory, DEV_CA_KEY_FILE))).toBe(0o600);
            expect(await readFile(join(directory, DEV_CA_CERT_FILE), 'utf8')).toBe(ca.certificatePem);
            expect(first.logger.entries).toEqual([
                {
                    level: 'info',
                    event: 'dev-ca.created',
                    fields: { reason: 'missing', path: join(directory, DEV_CA_CERT_FILE), domains: 'engine.test' },
                },
            ]);
            expect(first.logger.text()).not.toContain('PRIVATE KEY');

            const second = generated();
            const again = await second.load();
            expect(again.certificatePem).toBe(ca.certificatePem);
            expect(caKeyPem(again)).toBe(caKeyPem(ca));
            expect(second.logger.entries).toEqual([]);
        });

        it('regenerates when the permitted domains change', async () => {
            const ca = await generated().load();
            const changed = generated(createFakeClock(START_MS), [ENGINE_DOMAIN, E2E_DOMAIN]);
            const next = await changed.load();
            expect(next.certificatePem).not.toBe(ca.certificatePem);
            expect(next.permittedDomains).toEqual(['engine.test', 'ptbk.test']);
            expect(changed.logger.entries[0]?.fields['reason']).toBe('domains-changed');
            expect(await modeOf(join(dataDir, DEV_CA_DIRECTORY, DEV_CA_KEY_FILE))).toBe(0o600);
        });

        it('regenerates when the CA would expire within a leaf lifetime', async () => {
            const ca = await generated().load();
            const late = generated(createFakeClock(START_MS + DEV_CA_LIFETIME_MS - LEAF_LIFETIME_MS + 1000));
            const next = await late.load();
            expect(next.certificatePem).not.toBe(ca.certificatePem);
            expect(late.logger.entries[0]?.fields['reason']).toBe('expiring');
        });

        it('refuses a group-readable key, naming path and mode only', async () => {
            await generated().load();
            const keyPath = join(dataDir, DEV_CA_DIRECTORY, DEV_CA_KEY_FILE);
            await chmod(keyPath, 0o640);
            const error = await errorOf(generated().load());
            expect(error.message).toBe(
                `${DEV_CA_KEY_FILE} ${keyPath} is accessible by group or others (mode 0640); run chmod 600 ${keyPath}`,
            );
        });

        it('refuses a group-accessible dev CA directory', async () => {
            await generated().load();
            await chmod(join(dataDir, DEV_CA_DIRECTORY), 0o750);
            expect((await errorOf(generated().load())).message).toContain('dev CA directory');
        });

        it('refuses a directory holding only one of the two files', async () => {
            await generated().load();
            await rm(join(dataDir, DEV_CA_DIRECTORY, DEV_CA_CERT_FILE));
            expect((await errorOf(generated().load())).message).toContain(`holds only one of ${DEV_CA_CERT_FILE}`);
        });

        it('refuses stored files that are not a dev CA, without quoting them', async () => {
            await generated().load();
            const certPath = join(dataDir, DEV_CA_DIRECTORY, DEV_CA_CERT_FILE);
            await writeFile(certPath, 'not a certificate', { mode: 0o600 });
            const error = await errorOf(generated().load());
            expect(error.message).toBe(`${DEV_CA_CERT_FILE} ${certPath} is not a PEM certificate`);
        });

        it('refuses a group-accessible data directory', async () => {
            await mkdir(dataDir, { mode: 0o755 });
            await chmod(dataDir, 0o755);
            expect((await errorOf(generated().load())).message).toContain('PTBK_DATA_DIR');
        });
    });

    describe('from MOCK_DEV_CA_CERT_FILE and MOCK_DEV_CA_KEY_FILE', () => {
        let certFile: string;
        let keyFile: string;

        beforeEach(() => {
            certFile = join(root, 'provided-cert.pem');
            keyFile = join(root, 'provided-key.pem');
        });

        async function provide(certificatePem: string, keyPem: string, keyMode = 0o600): Promise<void> {
            await writeFile(certFile, certificatePem);
            await writeFile(keyFile, keyPem, { mode: keyMode });
            await chmod(keyFile, keyMode);
        }

        function load(clock = createFakeClock(START_MS)) {
            const logger = createMemoryLogger();
            return loadOrCreateDevCa({
                files: { certFile, keyFile },
                dataDir,
                permittedDomains: [ENGINE_DOMAIN],
                clock,
                logger,
            });
        }

        it('loads a name-constrained CA another tool wrote, and touches nothing in the data directory', async () => {
            const ca = createDevCa([ENGINE_DOMAIN, E2E_DOMAIN], createFakeClock(START_MS));
            await provide(ca.certificatePem, caKeyPem(ca));
            const loaded = await load();
            expect(loaded.certificatePem).toBe(ca.certificatePem);
            expect(loaded.permittedDomains).toEqual(['engine.test', 'ptbk.test']);
            await expect(stat(dataDir)).rejects.toThrow();
        });

        it('refuses an unconstrained CA with its own key', async () => {
            const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
            const pem = signCertificate({
                subject: 'Unconstrained',
                issuer: 'Unconstrained',
                notBefore: new Date(START_MS),
                notAfter: new Date(START_MS + DEV_CA_LIFETIME_MS),
                publicKey: keys.publicKey,
                issuerKey: keys.privateKey,
                extensions: [
                    basicConstraints({ ca: true, pathLen: 0 }),
                    keyUsage(KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign),
                ],
            });
            await provide(pem, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
            const error = await errorOf(load());
            expect(error.message).toBe(
                `MOCK_DEV_CA_CERT_FILE ${certFile} is not a name-constrained dev CA (critical name constraints with DNS subtrees and every IP excluded, pathLen 0, keyCertSign and cRLSign only)`,
            );
            expect(error.message).not.toContain('BEGIN');
        });

        it('refuses a key that does not belong to the certificate', async () => {
            const ca = createDevCa([ENGINE_DOMAIN], createFakeClock(START_MS));
            const other = createDevCa([ENGINE_DOMAIN], createFakeClock(START_MS));
            await provide(ca.certificatePem, caKeyPem(other));
            expect((await errorOf(load())).message).toBe(
                `MOCK_DEV_CA_KEY_FILE ${keyFile} does not belong to MOCK_DEV_CA_CERT_FILE ${certFile}`,
            );
        });

        it('refuses files that are not PEM, without quoting them', async () => {
            const ca = createDevCa([ENGINE_DOMAIN], createFakeClock(START_MS));
            await provide('secret-looking garbage', caKeyPem(ca));
            const certError = await errorOf(load());
            expect(certError.message).toBe(`MOCK_DEV_CA_CERT_FILE ${certFile} is not a PEM certificate`);
            await provide(ca.certificatePem, 'secret-looking garbage');
            const keyError = await errorOf(load());
            expect(keyError.message).toBe(`MOCK_DEV_CA_KEY_FILE ${keyFile} is not a PEM private key`);
            expect(keyError.message).not.toContain('garbage');
        });

        it('refuses a key that is not ECDSA P-256', async () => {
            const ca = createDevCa([ENGINE_DOMAIN], createFakeClock(START_MS));
            for (const key of [
                generateKeyPairSync('ed25519').privateKey,
                generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey,
            ]) {
                await provide(ca.certificatePem, key.export({ type: 'pkcs8', format: 'pem' }).toString());
                expect((await errorOf(load())).message).toBe(
                    `MOCK_DEV_CA_KEY_FILE ${keyFile} is not an ECDSA P-256 key`,
                );
            }
        });

        it('refuses a missing or unreadable file', async () => {
            const ca = createDevCa([ENGINE_DOMAIN], createFakeClock(START_MS));
            await writeFile(certFile, ca.certificatePem);
            expect((await errorOf(load())).message).toBe(`MOCK_DEV_CA_KEY_FILE ${keyFile} cannot be read`);
            await rm(certFile);
            await writeFile(keyFile, caKeyPem(ca), { mode: 0o600 });
            expect((await errorOf(load())).message).toBe(`MOCK_DEV_CA_CERT_FILE ${certFile} cannot be read`);
        });

        it('refuses a key file group or others can read', async () => {
            const ca = createDevCa([ENGINE_DOMAIN], createFakeClock(START_MS));
            await provide(ca.certificatePem, caKeyPem(ca), 0o644);
            expect((await errorOf(load())).message).toBe(
                `MOCK_DEV_CA_KEY_FILE ${keyFile} is accessible by group or others (mode 0644); run chmod 600 ${keyFile}`,
            );
        });

        it('refuses a CA that expires within a leaf lifetime', async () => {
            const ca = createDevCa([ENGINE_DOMAIN], createFakeClock(START_MS));
            await provide(ca.certificatePem, caKeyPem(ca));
            const clock = createFakeClock(START_MS + DEV_CA_LIFETIME_MS - LEAF_LIFETIME_MS + 1000);
            expect((await errorOf(load(clock))).message).toBe(
                `MOCK_DEV_CA_CERT_FILE ${certFile} expires within a leaf's lifetime`,
            );
        });
    });
});
