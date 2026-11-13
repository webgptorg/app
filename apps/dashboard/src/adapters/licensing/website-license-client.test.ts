import { expect, it } from 'vitest';
import { createWebsiteLicenseClient } from './website-license-client';
import type { LicenseSnapshot, WebsiteLicenseStore } from '../../domain/licensing/license-contract';
const subject = '4408b4d6-6005-4b77-97eb-fdd67847ee92';
const snapshot: LicenseSnapshot = {
    version: 1,
    subject,
    generatedAt: '2026-11-13T00:00:00.000Z',
    refreshAfterSeconds: 900,
    enforcement: 'advisory',
    manageUrl: 'https://www.ptbk.io/cs/pricing/predplatne',
    grants: [],
};
it('keeps a previous snapshot on outage and refuses another account response', async () => {
    let writes = 0;
    const store: WebsiteLicenseStore = {
        subjectForOrg: () => Promise.resolve(subject),
        readSnapshot: () => Promise.resolve(snapshot),
        saveSnapshot: () => {
            writes++;
            return Promise.resolve();
        },
    };
    const client = createWebsiteLicenseClient({
        store,
        secret: 'server-only',
        nowMs: () => Date.parse(snapshot.generatedAt) + 900_001,
        fetch: () =>
            Promise.resolve(
                Response.json({
                    ...snapshot,
                    subject: '4408b4d6-6005-4b77-97eb-fdd67847ee93',
                }),
            ),
    });
    expect(await client.read('org', new AbortController().signal)).toEqual({
        kind: 'stale',
        snapshot,
    });
    expect(writes).toBe(0);
});
it('fetches and stores known fields without depending on plan names', async () => {
    let saved: LicenseSnapshot | null = null;
    const store: WebsiteLicenseStore = {
        subjectForOrg: () => Promise.resolve(subject),
        readSnapshot: () => Promise.resolve(null),
        saveSnapshot: (_org, value) => {
            saved = value;
            return Promise.resolve();
        },
    };
    const client = createWebsiteLicenseClient({
        store,
        secret: 'server-only',
        nowMs: () => Date.parse(snapshot.generatedAt),
        fetch: (_url, options) => {
            expect(new Headers(options?.headers).get('authorization')).toBe('Bearer server-only');
            return Promise.resolve(Response.json({ ...snapshot, futureField: true }));
        },
    });
    expect(await client.read('org', new AbortController().signal)).toEqual({
        kind: 'current',
        snapshot,
    });
    expect(saved).toEqual(snapshot);
});
it('uses a fresh cache, leaves unlinked organizations unknown and tolerates an unavailable service', async () => {
    const readSnapshot = () => Promise.resolve(snapshot);
    const saveSnapshot = () => Promise.resolve();
    let fetches = 0;
    const store: WebsiteLicenseStore = { subjectForOrg: () => Promise.resolve(null), readSnapshot, saveSnapshot };
    const make = () =>
        createWebsiteLicenseClient({
            store,
            secret: 'server-only',
            nowMs: () => Date.parse(snapshot.generatedAt),
            fetch: () => {
                fetches++;
                return Promise.resolve(new Response(null, { status: 503 }));
            },
        });
    expect(await make().read('org', new AbortController().signal)).toEqual({ kind: 'unknown' });
    store.subjectForOrg = () => Promise.resolve(subject);
    expect(await make().read('org', new AbortController().signal)).toEqual({ kind: 'current', snapshot });
    expect(fetches).toBe(0);
    store.readSnapshot = () => Promise.resolve(null);
    expect(await make().read('org', new AbortController().signal)).toEqual({ kind: 'unknown' });
});
it('rejects future-dated snapshots and drops unrelated cached identities during an outage', async () => {
    const store: WebsiteLicenseStore = {
        subjectForOrg: () => Promise.resolve(subject),
        readSnapshot: () => Promise.resolve({ ...snapshot, subject: '4408b4d6-6005-4b77-97eb-fdd67847ee93' }),
        saveSnapshot: () => Promise.resolve(),
    };
    const client = createWebsiteLicenseClient({
        store,
        secret: 'server-only',
        nowMs: () => Date.parse(snapshot.generatedAt) - 120_001,
        fetch: () => Promise.resolve(Response.json(snapshot)),
    });
    expect(await client.read('org', new AbortController().signal)).toEqual({ kind: 'unknown' });
});
