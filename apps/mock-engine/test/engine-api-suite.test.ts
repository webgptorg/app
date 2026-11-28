import type { TLSSocket } from 'node:tls';
import { connect } from 'node:tls';

import {
    AccessRequestId,
    createFetchEngineApiClient,
    ENGINE_API_ROUTE_LIST,
    isReservedCapability,
    KNOWN_CAPABILITIES,
    MemberId,
    OWNER_PERMISSIONS,
} from '@ptbk/engine-api';
import { createInMemoryEngineCore } from '@ptbk/engine-api/in-memory';
import type { InMemoryEngine, InMemoryEngineApiOptions } from '@ptbk/engine-api/in-memory';
import { engineApiClientSuite } from '@ptbk/engine-api/testing';
import type { Hostname } from '@ptbk/protocol';
import {
    createCryptoRandom,
    EngineVersion,
    Hostname as HostnameSchema,
    RelayId,
    defaultHostname,
} from '@ptbk/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFaultSettings } from '../src/adapters/control-server';
import type { DevCa } from '../src/adapters/dev-ca';
import { createDevCa, createDevCaCertificateSource } from '../src/adapters/dev-ca';
import { createMemoryIdentityStore } from '../src/adapters/memory-identity-store';
import { createWsRelayDialer } from '../src/adapters/ws-relay-dialer';
import type { MockEngineConfig } from '../src/app/config';
import type { EngineServer, MockEngine } from '../src/app/start-mock-engine';
import { createEngineServer, startMockEngine } from '../src/app/start-mock-engine';
import { decideOwnership } from '../src/domain/authorization/policy';
import type { Clock } from '../src/domain/clock';
import { NO_FAULTS } from '../src/domain/faults/fault-plan';
import { SESSION_COOKIE_NAME, createSessionStore } from '../src/domain/gateway/sessions';
import type { ManagedCertificateSource } from '../src/domain/tls/certificate-source';
import { createContractRecorder } from '../src/testing/contract-recorder';
import { HARNESS_CANARY } from '../src/testing/engine-harness';
import type { FakePassthrough } from '../src/testing/fake-passthrough';
import { startFakePassthrough } from '../src/testing/fake-passthrough';
import type { FakeRelay } from '../src/testing/fake-relay';
import { startFakeRelay } from '../src/testing/fake-relay';
import { createMemoryLogger } from '../src/testing/memory-logger';
import { DEFAULT_MOCK_SETTINGS } from '../src/testing/mock-settings';
import { asBrowser, createNodeFetch } from '../src/testing/node-fetch';
import { lookupLoopback, trackLinkStates } from '../src/testing/test-hosts';
import { createTestCa } from '../src/testing/test-pki';

const ENGINE_DOMAIN = HostnameSchema.parse('engines.ptbk.test');
const RELAY = RelayId.parse('relay-a.ptbk.test');
const relayCa = createTestCa('M-04 relay CA');

const clock: Clock = {
    nowMs: () => Date.now(),
    setTimeout(fn, ms) {
        const timer = setTimeout(fn, ms);
        return () => {
            clearTimeout(timer);
        };
    },
};

interface Tunnel {
    readonly relay: FakeRelay;
    readonly engine: MockEngine;
    readonly passthrough: FakePassthrough;
    readonly hostname: Hostname;
    readonly devCa: DevCa;
    readonly certificates: ManagedCertificateSource;
}

let tunnel: Tunnel | undefined;
const servers: EngineServer[] = [];
const sockets = new Set<TLSSocket>();
const recorder = createContractRecorder();
const logger = createMemoryLogger();

/** One relay, one engine and its tunnel for the whole file; each test's core is served through it in turn. */
beforeAll(async () => {
    const identityStore = createMemoryIdentityStore();
    const identity = await identityStore.loadOrCreate();
    const hostname = defaultHostname(identity.engineId, ENGINE_DOMAIN);
    const relay = await startFakeRelay({
        relayId: RELAY,
        tls: relayCa.issue([RELAY]),
        registry: (engineId) =>
            engineId === identity.engineId ? { publicKey: identity.publicKey, hostnames: [hostname] } : undefined,
    });
    const devCa = createDevCa([ENGINE_DOMAIN], clock);
    const certificates = createDevCaCertificateSource({ ca: devCa, clock, logger });
    const states = trackLinkStates();
    const config: MockEngineConfig = {
        mode: 'tunnel',
        dataDir: '/unused',
        relays: [{ url: relay.url, relayId: RELAY, port: relay.port }],
        engineDomain: ENGINE_DOMAIN,
        engineVersion: EngineVersion.parse('0.1.0'),
        proxy: null,
        extraCaFile: null,
        devCaFiles: null,
        devCaDomains: [],
        certificateSource: { kind: 'dev-ca' },
        logLevel: 'info',
        ...DEFAULT_MOCK_SETTINGS,
    };
    const engine = await startMockEngine(config, {
        logger,
        clock,
        random: createCryptoRandom(),
        identityStore,
        dialer: createWsRelayDialer({ clock, proxy: null, ca: [relayCa.certPem], lookup: lookupLoopback }),
        certificates,
        onLinkState: states.onLinkState,
    });
    await states.next(RELAY, 'ready');
    const passthrough = await startFakePassthrough(await relay.waitForSession());
    tunnel = { relay, engine, passthrough, hostname, devCa, certificates };
});

afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
    await tunnel?.passthrough.close();
    await tunnel?.engine.close();
    await tunnel?.relay.close();
});

function through(): Tunnel {
    if (tunnel === undefined) throw new Error('tunnel not ready');
    return tunnel;
}

/** HTTPS to the relay's browser port, verified against the dev CA for the engine's hostname, as a browser would. */
function relayFetch(): typeof fetch {
    const { passthrough, hostname, devCa } = through();
    return createNodeFetch({
        host: hostname,
        connect: () => {
            const socket = connect({
                host: '127.0.0.1',
                port: passthrough.port,
                servername: hostname,
                ca: devCa.certificatePem,
                ALPNProtocols: ['http/1.1'],
            });
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
            return socket;
        },
    });
}

/** Serves a fresh core through the tunnel and signs in the member the options describe, as the in-memory client does. */
function serveCore(options: InMemoryEngineApiOptions): InMemoryEngine {
    {
        const { engine, certificates, hostname } = through();
        const core = createInMemoryEngineCore({ ...options, authorizer: { can: decideOwnership } });
        const sessions = createSessionStore({ engine: () => core.controller, clock, random: createCryptoRandom() });
        const memberId = options.member?.id ?? 'member-owner';
        const current = options.seed?.sessions?.find((session) => session.memberId === memberId && session.current);
        const { token } = sessions.signIn({
            memberId,
            permissions: options.member?.permissions ?? OWNER_PERMISSIONS,
            client: { ip: '127.0.0.1', userAgent: 'client suite' },
            sessionId: current?.id ?? 'session-current',
            stepUp: options.stepUp === 'required' ? 'none' : 'fresh',
        });
        const server = createEngineServer({
            engineId: engine.identity.engineId,
            certificates,
            core: () => core,
            sessions,
            faults: createFaultSettings(NO_FAULTS),
            seed: 1,
            devLogin: false,
            canary: HARNESS_CANARY,
            clock,
            logger,
            rateLimiter: { consume: () => ({ kind: 'allowed' }) },
        });
        servers.push(server);
        engine.onStream((stream) => {
            server.handle(stream, {
                family: stream.remoteFamily,
                address: stream.remoteAddress,
                port: stream.remotePort,
            });
        });
        const origin = `https://${hostname}:${String(through().passthrough.port)}`;
        const client = createFetchEngineApiClient({
            baseUrl: origin,
            fetch: asBrowser(
                recorder.wrap(relayFetch()),
                `https://${hostname}`,
                () => `${SESSION_COOKIE_NAME}=${token}`,
            ),
            timeoutMs: 10_000,
        });
        return { client, controller: core.controller };
    }
}

describe('the shared engine API client suite, against the mock engine through the relay', () => {
    engineApiClientSuite(serveCore);
});

describe('operations the shared suite leaves out', () => {
    const signal = () => AbortSignal.timeout(10_000);

    it('answer through the relay too', async () => {
        const { client } = serveCore({
            seed: {
                members: [
                    {
                        id: 'member-owner',
                        displayName: 'Owner',
                        role: 'owner',
                        status: 'active',
                        createdAt: '2026-10-01T00:00:00Z',
                        lastSeenAt: null,
                    },
                    {
                        id: 'member-ada',
                        displayName: 'Ada',
                        role: 'member',
                        status: 'active',
                        createdAt: '2026-10-01T00:00:00Z',
                        lastSeenAt: null,
                    },
                ],
                accessRequests: [
                    {
                        request: {
                            id: 'access-approve',
                            displayName: 'Petr',
                            email: 'petr@example.com',
                            proposedRole: 'member',
                            createdAt: '2026-10-01T00:00:00Z',
                            expiresAt: '2099-01-01T00:00:00Z',
                        },
                        code: '123456',
                        dashboardUserId: 'user-a',
                    },
                    {
                        request: {
                            id: 'access-decline',
                            displayName: 'Petr',
                            email: 'petr@example.com',
                            proposedRole: 'member',
                            createdAt: '2026-10-01T00:00:00Z',
                            expiresAt: '2099-01-01T00:00:00Z',
                        },
                        code: '123456',
                        dashboardUserId: 'user-b',
                    },
                ],
                onboarding: 'pending',
            },
        });
        const agent = await client.agents.create({ source: 'Ada' }, signal());
        if (agent.kind !== 'ok') throw new Error('agent');
        expect((await client.agents.getStatus(agent.data.id, signal())).kind).toBe('ok');
        expect((await client.agents.start(agent.data.id, signal())).kind).toBe('ok');
        expect(await client.agents.stop(agent.data.id, signal())).toMatchObject({
            kind: 'ok',
            data: { state: 'stopped' },
        });
        const folder = await client.folders.create({ name: 'Team' }, signal());
        if (folder.kind !== 'ok') throw new Error('folder');
        expect((await client.folders.list({}, signal())).kind).toBe('ok');
        expect((await client.folders.rename(folder.data.id, { name: 'Crew' }, signal())).kind).toBe('ok');
        expect((await client.chats.list(agent.data.id, {}, signal())).kind).toBe('ok');
        const ada = MemberId.parse('member-ada');
        expect((await client.members.get(ada, signal())).kind).toBe('ok');
        expect(await client.members.update(ada, { role: 'viewer' }, signal())).toMatchObject({
            kind: 'ok',
            data: { role: 'viewer' },
        });
        const invite = await client.members.createInvite(
            { role: 'viewer', expiresAt: '2027-01-01T00:00:00Z' },
            signal(),
        );
        if (invite.kind !== 'ok') throw new Error('invite');
        expect((await client.members.listInvites({}, signal())).kind).toBe('ok');
        expect((await client.members.revokeInvite(invite.data.invite.id, signal())).kind).toBe('ok');
        expect((await client.members.remove(ada, signal())).kind).toBe('ok');
        expect((await client.settings.get(signal())).kind).toBe('ok');
        expect((await client.members.listAccessRequests({}, signal())).kind).toBe('ok');
        const approve = AccessRequestId.parse('access-approve');
        expect(
            (await client.members.approveAccessRequest(approve, { code: '123456', role: 'member' }, signal())).kind,
        ).toBe('ok');
        expect(
            (await client.members.declineAccessRequest(AccessRequestId.parse('access-decline'), signal())).kind,
        ).toBe('ok');
        expect((await client.settings.setDashboardRemovals({ enabled: false }, signal())).kind).toBe('ok');
        expect((await client.integrations.connectCalendar({ provider: 'google' }, signal())).kind).toBe('ok');
        const onboarding = await client.onboarding.get(signal());
        if (onboarding.kind !== 'ok' || onboarding.data.prompt === null) throw new Error('onboarding');
        const promptId = onboarding.data.prompt.id;
        expect(
            (
                await client.onboarding.answer(
                    { promptId, action: 'answer', answer: { kind: 'text', text: 'A bakery', fileIds: [] } },
                    signal(),
                )
            ).kind,
        ).toBe('ok');
        expect((await client.onboarding.defer(signal())).kind).toBe('ok');
    });
});

describe('every response of that run', () => {
    it('matches the strict response schema of its route', async () => {
        await recorder.settled();
        expect(recorder.violations).toEqual([]);
    });

    it('came from every operation of the route table', () => {
        // Reserved routes have no client method; capabilities.test.ts checks that they answer 404. The shared client
        // suite has no `browser-tab@1` cases yet (C-16); capabilities.test.ts answers each of its routes instead. Voice
        // is served only with `MOCK_VOICE`, and voice.test.ts answers its routes; so does capabilities.test.ts for
        // `ai-tools@1`, whose sign-ins the shared suite does not drive.
        const notCovered = new Set<string>([
            KNOWN_CAPABILITIES.browserTab.id,
            KNOWN_CAPABILITIES.aiTools.id,
            KNOWN_CAPABILITIES.voiceInput.id,
            KNOWN_CAPABILITIES.voiceOutput.id,
            // Served from M-16 on.
            KNOWN_CAPABILITIES.notifications.id,
        ]);
        const missing = ENGINE_API_ROUTE_LIST.filter(
            (route) =>
                route.capability === undefined ||
                (!isReservedCapability(route.capability) && !notCovered.has(route.capability.id)),
        )
            .map(({ id }) => id)
            .filter((id) => !recorder.answered.has(id));
        expect(missing).toEqual([]);
    });
});
