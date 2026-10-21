import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplexPair } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { checkServerIdentity, connect } from 'node:tls';

import { Hostname } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { loadOrCreateAcmeAccountKey } from '../src/adapters/acme-account-key';
import {
    ACME_CERTIFICATE_FILE,
    ACME_KEY_FILE,
    ACME_TLS_DIRECTORY,
    createAcmeCertificateSource,
} from '../src/adapters/acme-certificate-source';
import { createAcmeClientIssuer } from '../src/adapters/acme-client-issuer';
import { createClientHelloRouter } from '../src/adapters/client-hello-router';
import { createTlsAlpnResponder } from '../src/adapters/tls-alpn-responder';
import { createTlsStreamServer } from '../src/adapters/tls-stream-server';
import type { Clock } from '../src/domain/clock';
import { createAcmeChallenges } from '../src/domain/tls/acme-challenges';
import { IssueFailedError } from '../src/domain/tls/certificate-issuer';
import type { FakeAcmeServerOptions } from '../src/testing/fake-acme-server';
import { startFakeAcmeServer } from '../src/testing/fake-acme-server';
import { createMemoryLogger } from '../src/testing/memory-logger';

const HOST = Hostname.parse('abcdefghijklmnopqrstuvwxyz.engine.test');
const OTHER = Hostname.parse('chat.customer.test');

const realClock: Clock = {
    nowMs: () => Date.now(),
    setTimeout(fn, ms) {
        const timer = setTimeout(fn, ms);
        return () => {
            clearTimeout(timer);
        };
    },
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The engine's side of the tunnel, as start-mock-engine builds it, fed by linked duplexes instead of streams. */
async function setup(serverOptions: Omit<FakeAcmeServerOptions, 'validate'> = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'ptbk-acme-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const logger = createMemoryLogger();
    const challenges = createAcmeChallenges();
    const accountKey = await loadOrCreateAcmeAccountKey(dataDir);

    let router: ReturnType<typeof createClientHelloRouter> | undefined = undefined;
    function open(servername: string, alpn: string[], ca?: string): TLSSocket {
        const [client, server] = duplexPair();
        client.once('close', () => server.destroy());
        server.once('close', () => client.destroy());
        router?.handle(server, { family: 'IPv4', address: '192.0.2.40', port: 40_000 });
        const socket = connect({
            socket: client,
            servername,
            ALPNProtocols: alpn,
            ...(ca === undefined
                ? { rejectUnauthorized: false }
                : {
                      ca,
                      checkServerIdentity: (_host: string, cert: Parameters<typeof checkServerIdentity>[1]) =>
                          checkServerIdentity(servername, cert),
                  }),
        });
        socket.on('error', () => undefined);
        return socket;
    }

    const acme = await startFakeAcmeServer({
        ...serverOptions,
        async validate(hostname) {
            const socket = open(hostname, ['acme-tls/1']);
            try {
                await once(socket, 'secureConnect');
                if (socket.alpnProtocol !== 'acme-tls/1') throw new Error('acme-tls/1 was not negotiated');
                const certificate = socket.getPeerX509Certificate();
                if (certificate === undefined) throw new Error('no certificate');
                return certificate;
            } finally {
                // A validator closes politely after the handshake, so the engine sees it complete.
                socket.end();
            }
        },
    });
    cleanups.push(() => acme.close());
    const issuer = createAcmeClientIssuer({
        directoryUrl: acme.directoryUrl,
        accountKey,
        email: 'ops@example.test',
        challenges,
        logger,
    });
    const source = await createAcmeCertificateSource({ issuer, dataDir, clock: realClock, logger });
    const tls = createTlsStreamServer({
        certificates: source,
        logger,
        onSecureConnection: (socket) => {
            socket.end();
        },
    });
    const responder = createTlsAlpnResponder({ challenges, logger });
    router = createClientHelloRouter({
        challenges,
        responder,
        normal: (stream, remote) => {
            tls.handle(stream, remote);
        },
        clock: realClock,
        logger,
    });
    const built = router;
    cleanups.push(() => {
        built.close();
        responder.close();
        tls.close();
        source.close();
    });
    return { acme, issuer, source, challenges, logger, dataDir, open };
}

async function outcome(socket: TLSSocket): Promise<'handshake' | 'closed'> {
    const result = await Promise.race([
        once(socket, 'secureConnect').then(() => 'handshake' as const),
        once(socket, 'close').then(() => 'closed' as const),
    ]);
    socket.destroy();
    return result;
}

describe('ACME TLS-ALPN-01 issuance with acme-client, through the ClientHello router', () => {
    it('obtains a certificate the engine then serves, answering the validation itself', async () => {
        const { acme, source, challenges, logger, dataDir, open } = await setup();
        const changed = new Promise<void>((resolve) => source.onChange(resolve));
        source.addHostnames([HOST]);
        source.routable();
        await changed;

        expect(acme.validations).toEqual([{ hostname: HOST, valid: true }]);
        expect(acme.accounts).toEqual([['mailto:ops@example.test']]);
        expect(
            challenges.lookup(HOST),
            'the challenge certificate is gone once the authorization settled',
        ).toBeUndefined();
        const browser = open(HOST, ['http/1.1'], acme.caPem);
        await once(browser, 'secureConnect');
        expect(browser.getPeerX509Certificate()?.checkHost(HOST)).toBe(HOST);
        browser.destroy();

        const events = logger.entries.map((entry) => entry.event);
        expect(events).toEqual(
            expect.arrayContaining([
                'acme.order-created',
                'acme.challenge-served',
                'acme.challenge-valid',
                'acme.certificate-issued',
            ]),
        );
        const issued = logger.entries.find((entry) => entry.event === 'acme.certificate-issued');
        expect(issued?.fields['notAfter']).toMatch(/^\d{4}-\d\d-\d\dT/);
        const logged = JSON.stringify(logger.entries);
        expect(logged).not.toContain('PRIVATE KEY');
        expect(logged).not.toContain('/acct/');
        for (const file of [ACME_CERTIFICATE_FILE, ACME_KEY_FILE]) {
            expect((await stat(join(dataDir, ACME_TLS_DIRECTORY, file))).mode & 0o777).toBe(0o600);
        }
    });

    it('refuses an acme-tls/1 connection once no challenge is pending, and keeps serving browsers', async () => {
        const { acme, source, logger, open } = await setup();
        const changed = new Promise<void>((resolve) => source.onChange(resolve));
        source.addHostnames([HOST]);
        source.routable();
        await changed;
        expect(await outcome(open(HOST, ['acme-tls/1']))).toBe('closed');
        expect(logger.entries).toContainEqual(
            expect.objectContaining({ event: 'tls.hello-rejected', fields: { reason: 'no-pending-challenge' } }),
        );
        expect(await outcome(open(HOST, ['http/1.1'], acme.caPem))).toBe('handshake');
    });

    it('creates the account once and orders every hostname in one certificate', async () => {
        const { acme, issuer } = await setup();
        await issuer.issue([HOST], new AbortController().signal);
        const both = await issuer.issue([HOST, OTHER], new AbortController().signal);
        expect(acme.accounts).toHaveLength(1);
        expect(acme.validations.map((validation) => validation.hostname)).toEqual([HOST, HOST, OTHER]);
        expect(both.certificateChainPem).toContain('BEGIN CERTIFICATE');
    });

    it('skips authorizations the CA already holds as valid', async () => {
        const { acme, issuer } = await setup({ preauthorized: [HOST] });
        await issuer.issue([HOST], new AbortController().signal);
        expect(acme.validations).toEqual([]);
    });

    it('fails at the challenge stage when validation fails, and removes the challenge certificate', async () => {
        const { acme, dataDir } = await setup();
        // Registered where the engine's router never looks: the CA reaches an engine that does not hold the challenge.
        const elsewhere = createAcmeChallenges();
        const issuer = createAcmeClientIssuer({
            directoryUrl: acme.directoryUrl,
            accountKey: await loadOrCreateAcmeAccountKey(dataDir),
            email: null,
            challenges: elsewhere,
            logger: createMemoryLogger(),
        });
        const error = await issuer.issue([HOST], new AbortController().signal).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(IssueFailedError);
        expect((error as IssueFailedError).stage).toBe('challenge');
        expect(acme.validations).toEqual([{ hostname: HOST, valid: false }]);
        expect(acme.accounts).toEqual([[]]);
        expect(elsewhere.lookup(HOST)).toBeUndefined();
    });

    it('fails at the challenge stage when the CA offers no tls-alpn-01 challenge', async () => {
        const { issuer } = await setup({ challengeTypes: ['http-01', 'dns-01'] });
        const error = await issuer.issue([HOST], new AbortController().signal).catch((caught: unknown) => caught);
        expect((error as IssueFailedError).stage).toBe('challenge');
    });

    it('fails at the account stage when the CA refuses the account, and asks again next time', async () => {
        const { acme, issuer } = await setup();
        acme.rejectAccounts = true;
        const first = await issuer.issue([HOST], new AbortController().signal).catch((caught: unknown) => caught);
        expect((first as IssueFailedError).stage).toBe('account');
        acme.rejectAccounts = false;
        await issuer.issue([HOST], new AbortController().signal);
        expect(acme.accounts).toHaveLength(1);
    });

    it('stops before any request once aborted', async () => {
        const { acme, issuer } = await setup();
        const controller = new AbortController();
        controller.abort(new Error('stopped'));
        await expect(issuer.issue([HOST], controller.signal)).rejects.toThrow('stopped');
        expect(acme.accounts).toEqual([]);
    });
});
