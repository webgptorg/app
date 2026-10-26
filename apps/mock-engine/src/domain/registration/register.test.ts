import type { EngineVersion, LinkCode, RegisterEngineRequest } from '@ptbk/protocol';
import {
    EngineVersion as EngineVersionSchema,
    Hostname,
    REGISTRATION_ERROR_CODE,
    defaultHostname,
    ed25519PublicKeyFromBytes,
    generateLinkCode,
    verifyRegistration,
} from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createTestIdentity } from '../../testing/test-identity';
import { createMemoryRegistrationStore } from '../../testing/memory-registration-store';
import { createFakeClock } from '../../testing/fake-clock';
import type { FakeDashboard, RegisterAnswer } from '../../testing/fake-dashboard';
import { createFakeDashboard } from '../../testing/fake-dashboard';
import { createMemoryLogger } from '../../testing/memory-logger';
import { createSeededRandom } from '../../testing/seeded-random';
import type { DashboardApi, RegisterCall } from '../dashboard/dashboard-api';
import type { EngineIdentity } from '../identity/engine-identity';
import type { RegisterEngineDeps } from './register';
import { StoredRegistrationError, loadRegistration, registerEngine } from './register';
import type { Registration } from './registration';

const ENGINE_DOMAIN = Hostname.parse('engines.ptbk.test');
const OTHER_DOMAIN = Hostname.parse('engines.other.test');
const RELAYS = [Hostname.parse('relay-a.ptbk.test'), Hostname.parse('relay-b.ptbk.test')];
const DASHBOARD_URL = 'https://app.ptbk.test';
const VERSION = EngineVersionSchema.parse('0.1.0');

function problem(status: number, code: string): RegisterAnswer {
    return { status, body: { type: 'about:blank', title: code, status, code } };
}

/** Counts every call that would leave the engine. */
function counting(api: DashboardApi): DashboardApi & { readonly calls: () => number } {
    let calls = 0;
    return {
        register(request, signal) {
            calls++;
            return api.register(request, signal);
        },
        heartbeat(engineId, rawBody, signature, signal) {
            calls++;
            return api.heartbeat(engineId, rawBody, signature, signal);
        },
        calls: () => calls,
    };
}

async function newIdentity(): Promise<EngineIdentity> {
    return createTestIdentity();
}

async function setup(options: { readonly dashboard?: FakeDashboard } = {}) {
    const dashboard =
        options.dashboard ??
        createFakeDashboard({ clock: createFakeClock(), engineDomain: ENGINE_DOMAIN, relays: RELAYS });
    const api = counting(dashboard.api);
    const store = createMemoryRegistrationStore();
    const identity = await newIdentity();
    const logger = createMemoryLogger();
    const deps = (linkCode: LinkCode, overrides: Partial<RegisterEngineDeps> = {}): RegisterEngineDeps => ({
        store,
        api,
        identity,
        dashboardUrl: DASHBOARD_URL,
        engineDomain: ENGINE_DOMAIN,
        engineVersion: VERSION,
        linkCode,
        logger,
        signal: new AbortController().signal,
        ...overrides,
    });
    return { dashboard, api, store, identity, logger, deps };
}

function received(dashboard: FakeDashboard): RegisterEngineRequest {
    const request = dashboard.registerRequests.at(-1);
    if (request === undefined) throw new Error('no registration request');
    return request;
}

describe('registerEngine', () => {
    it('registers, stores the confirmed identity and adopts the relays', async () => {
        const { dashboard, store, identity, deps } = await setup();
        const outcome = await registerEngine(deps(dashboard.issueLinkCode('org-a')));
        const expected: Registration = {
            dashboardUrl: DASHBOARD_URL,
            engineId: identity.engineId,
            hostname: defaultHostname(identity.engineId, ENGINE_DOMAIN),
            relays: RELAYS,
        };
        expect(outcome).toEqual({ kind: 'registered', registration: expected });
        expect(await store.load()).toEqual(expected);
        expect(received(dashboard).mode).toBe('tunnel');
    });

    it('reports an existing registration without a network call', async () => {
        const { dashboard, api, deps } = await setup();
        const first = await registerEngine(deps(dashboard.issueLinkCode('org-a')));
        expect(api.calls()).toBe(1);
        const second = await registerEngine(deps(dashboard.issueLinkCode('org-a')));
        expect(second).toEqual({
            kind: 'already-registered',
            registration: first.kind === 'registered' ? first.registration : null,
        });
        expect(api.calls()).toBe(1);
    });

    describe('dashboard rejections', () => {
        it('maps an unknown link code to invalid-link-code', async () => {
            const { store, deps } = await setup();
            const unknown = generateLinkCode(createSeededRandom(99));
            expect(await registerEngine(deps(unknown))).toEqual({ kind: 'rejected', reason: 'invalid-link-code' });
            expect(await store.load()).toBeNull();
        });

        it('maps a used link code to the same invalid-link-code', async () => {
            const { dashboard, deps } = await setup();
            const code = dashboard.issueLinkCode('org-a');
            await registerEngine(deps(code));
            const other = await setup({ dashboard });
            expect(await registerEngine(other.deps(code))).toEqual({
                kind: 'rejected',
                reason: 'invalid-link-code',
            });
            expect(await other.store.load()).toBeNull();
        });

        it('maps a key registered to another organisation to engine-exists', async () => {
            const { dashboard, store, deps } = await setup();
            await registerEngine(deps(dashboard.issueLinkCode('org-a')));
            store.clear();
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-b')))).toEqual({
                kind: 'rejected',
                reason: 'engine-exists',
            });
            expect(await store.load()).toBeNull();
        });

        it('maps a suspended engine to engine-suspended', async () => {
            const { dashboard, store, identity, deps } = await setup();
            await registerEngine(deps(dashboard.issueLinkCode('org-a')));
            store.clear();
            dashboard.suspend(identity.engineId);
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a')))).toEqual({
                kind: 'rejected',
                reason: 'engine-suspended',
            });
            expect(await store.load()).toBeNull();
        });

        it('maps a full account to engine-limit', async () => {
            const { dashboard, store, deps } = await setup();
            dashboard.setEngineLimit('org-a', 0);
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a')))).toEqual({
                kind: 'rejected',
                reason: 'engine-limit',
            });
            expect(await store.load()).toBeNull();
        });

        it('maps a plan without engines to not-entitled', async () => {
            const { dashboard, store, deps } = await setup();
            dashboard.overrideRegister(() => problem(403, REGISTRATION_ERROR_CODE.notEntitled));
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a')))).toEqual({
                kind: 'rejected',
                reason: 'not-entitled',
            });
            expect(await store.load()).toBeNull();
        });

        it('takes rate-limited as a request to come back later, not a rejection', async () => {
            const { dashboard, store, logger, deps } = await setup();
            dashboard.overrideRegister(() => problem(429, REGISTRATION_ERROR_CODE.rateLimited));
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a')))).toEqual({
                kind: 'unavailable',
                reason: 'rate-limited',
            });
            expect(logger.entries[0]?.fields).toEqual({ status: 429, code: 'rate-limited' });
            expect(await store.load()).toBeNull();
        });

        it('maps a refused signature to bad-signature', async () => {
            const { dashboard, store, deps } = await setup();
            dashboard.overrideRegister(() => problem(401, REGISTRATION_ERROR_CODE.badSignature));
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a')))).toEqual({
                kind: 'rejected',
                reason: 'bad-signature',
            });
            expect(await store.load()).toBeNull();
        });

        it('covers every registration error code', () => {
            expect(Object.values(REGISTRATION_ERROR_CODE).sort()).toEqual([
                'bad-signature',
                'engine-exists',
                'engine-limit',
                'engine-suspended',
                'invalid-link-code',
                'not-entitled',
                'rate-limited',
            ]);
        });
    });

    describe('refused responses', () => {
        it('refuses an engine ID its key does not derive', async () => {
            const { dashboard, store, deps } = await setup();
            const foreign = await newIdentity();
            dashboard.overrideRegister(() => ({
                status: 200,
                body: {
                    engineId: foreign.engineId,
                    hostname: defaultHostname(foreign.engineId, ENGINE_DOMAIN),
                    relays: RELAYS,
                },
            }));
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a')))).toEqual({
                kind: 'refused-response',
                reason: 'engine-id-mismatch',
            });
            expect(await store.load()).toBeNull();
        });

        it('refuses a hostname outside the engine domain', async () => {
            const { dashboard, store, identity, deps } = await setup();
            dashboard.overrideRegister(() => ({
                status: 200,
                body: {
                    engineId: identity.engineId,
                    hostname: defaultHostname(identity.engineId, OTHER_DOMAIN),
                    relays: RELAYS,
                },
            }));
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a')))).toEqual({
                kind: 'refused-response',
                reason: 'hostname-mismatch',
            });
            expect(await store.load()).toBeNull();
        });

        it('refuses a response the adapter could not read', async () => {
            const { dashboard, store, deps } = await setup();
            const invalid: DashboardApi = {
                register: (): Promise<RegisterCall> => Promise.resolve({ kind: 'invalid-response', status: 200 }),
                heartbeat: (...args) => dashboard.api.heartbeat(...args),
            };
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a'), { api: invalid }))).toEqual({
                kind: 'refused-response',
                reason: 'invalid',
            });
            expect(await store.load()).toBeNull();
        });
    });

    describe('unavailable dashboard', () => {
        it('reports an unreachable dashboard and logs nothing but the event', async () => {
            const { dashboard, store, logger, deps } = await setup();
            dashboard.unreachable = true;
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a')))).toEqual({
                kind: 'unavailable',
                reason: 'no-answer',
            });
            expect(logger.entries).toEqual([{ level: 'warn', event: 'registration.unavailable', fields: {} }]);
            expect(await store.load()).toBeNull();
        });

        it('treats an unknown problem code as unavailable and logs its status and code', async () => {
            const { dashboard, store, logger, deps } = await setup();
            dashboard.overrideRegister(() => problem(503, 'a-code-added-later'));
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a')))).toEqual({
                kind: 'unavailable',
                reason: 'unknown-code',
            });
            expect(logger.entries).toEqual([
                {
                    level: 'warn',
                    event: 'registration.unavailable',
                    fields: { status: 503, code: 'a-code-added-later' },
                },
            ]);
            expect(await store.load()).toBeNull();
        });

        it('logs the status of an error answer without a problem', async () => {
            const { dashboard, logger, deps } = await setup();
            const failing: DashboardApi = {
                register: (): Promise<RegisterCall> => Promise.resolve({ kind: 'unavailable', status: 502 }),
                heartbeat: (...args) => dashboard.api.heartbeat(...args),
            };
            expect(await registerEngine(deps(dashboard.issueLinkCode('org-a'), { api: failing }))).toEqual({
                kind: 'unavailable',
                reason: 'error-status',
            });
            expect(logger.entries[0]?.fields).toEqual({ status: 502 });
        });
    });

    it('re-registers a kept key idempotently after registration.json is lost', async () => {
        const { dashboard, store, identity, deps } = await setup();
        const first = await registerEngine(deps(dashboard.issueLinkCode('org-a')));
        expect(dashboard.engine(identity.engineId)?.engineVersion).toBe('0.1.0');
        store.clear();
        const newer: EngineVersion = EngineVersionSchema.parse('0.2.0');
        const second = await registerEngine(deps(dashboard.issueLinkCode('org-a'), { engineVersion: newer }));
        expect(second.kind).toBe('registered');
        expect(second).toEqual({ ...first, kind: 'registered' });
        if (second.kind !== 'registered') throw new Error('not registered');
        expect(second.registration.engineId).toBe(identity.engineId);
        expect(second.registration.hostname).toBe(defaultHostname(identity.engineId, ENGINE_DOMAIN));
        expect(dashboard.engine(identity.engineId)?.engineVersion).toBe('0.2.0');
        expect(await store.load()).toEqual(second.registration);
    });

    describe('the signed request', () => {
        it('verifies with verifyRegistration, and fails once any signed field changes', async () => {
            const { dashboard, deps } = await setup();
            await registerEngine(deps(dashboard.issueLinkCode('org-a')));
            const request = received(dashboard);
            expect(verifyRegistration(request)).toBe(true);
            const otherKey = ed25519PublicKeyFromBytes((await newIdentity()).publicKey);
            const tampered: RegisterEngineRequest[] = [
                { ...request, linkCode: generateLinkCode(createSeededRandom(1234)) },
                { ...request, enginePublicKey: otherKey },
                { ...request, engineVersion: EngineVersionSchema.parse('0.1.1') },
                { ...request, mode: 'direct' },
            ];
            for (const changed of tampered) expect(verifyRegistration(changed)).toBe(false);
        });

        it('never logs or stores the link code', async () => {
            const { dashboard, store, logger, deps } = await setup();
            const code = dashboard.issueLinkCode('org-a');
            await registerEngine(deps(code));
            dashboard.unreachable = true;
            store.clear();
            await registerEngine(deps(code));
            expect(logger.text()).not.toContain(code);
            dashboard.unreachable = false;
            await registerEngine(deps(dashboard.issueLinkCode('org-a')));
            expect(JSON.stringify(await store.load())).not.toContain(code);
        });
    });
});

describe('loadRegistration', () => {
    async function stored(registration: Partial<Registration> = {}) {
        const identity = await newIdentity();
        const store = createMemoryRegistrationStore({
            dashboardUrl: DASHBOARD_URL,
            engineId: identity.engineId,
            hostname: defaultHostname(identity.engineId, ENGINE_DOMAIN),
            relays: RELAYS,
            ...registration,
        });
        return { identity, store };
    }

    it('returns null when the engine never registered', async () => {
        const identity = await newIdentity();
        expect(
            await loadRegistration({
                store: createMemoryRegistrationStore(),
                identity,
                dashboardUrl: DASHBOARD_URL,
                engineDomain: ENGINE_DOMAIN,
            }),
        ).toBeNull();
    });

    it('returns a registration that matches the key, domain and dashboard', async () => {
        const { identity, store } = await stored();
        const loaded = await loadRegistration({
            store,
            identity,
            dashboardUrl: DASHBOARD_URL,
            engineDomain: ENGINE_DOMAIN,
        });
        expect(loaded?.engineId).toBe(identity.engineId);
    });

    it('refuses a registration of another key', async () => {
        const { store } = await stored();
        const identity = await newIdentity();
        await expect(
            loadRegistration({ store, identity, dashboardUrl: DASHBOARD_URL, engineDomain: ENGINE_DOMAIN }),
        ).rejects.toThrow(new StoredRegistrationError('the stored registration belongs to another engine key'));
    });

    it('refuses a registration for another engine domain', async () => {
        const { identity, store } = await stored();
        await expect(
            loadRegistration({ store, identity, dashboardUrl: DASHBOARD_URL, engineDomain: OTHER_DOMAIN }),
        ).rejects.toThrow(StoredRegistrationError);
    });

    it('refuses a registration with another dashboard', async () => {
        const { identity, store } = await stored();
        await expect(
            loadRegistration({ store, identity, dashboardUrl: 'https://other.ptbk.test', engineDomain: ENGINE_DOMAIN }),
        ).rejects.toThrow(/another dashboard/);
    });
});
