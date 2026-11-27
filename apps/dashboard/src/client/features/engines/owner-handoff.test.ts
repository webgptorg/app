import { ownerSetupCommitment, OwnerSetupSecret } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { EngineView, LinkCodeStatusView } from '../../../shared/api/routes';
import { ENGINE_DOMAIN, ENGINE_ID, engineView } from '../../testing/fixtures';
import { createMemorySessionStorage } from '../../testing/memory-storage';
import {
    canKeepOwnerSetupSecret,
    drawOwnerSetup,
    handOffOwnerSetup,
    holdsOwnerSetupSecret,
    keepOwnerSetupSecret,
    ownerHandoffHostname,
    type OwnerSetupStorage,
} from './owner-handoff';

const LINK_ID = 'lllllllllllllllllllllllllq';
const OTHER_LINK_ID = 'mmmmmmmmmmmmmmmmmmmmmmmmmq';
const KEY = `ptbk.ownerSetup.${LINK_ID}`;
const SECRET = OwnerSetupSecret.parse('AAECAwQFBgcICQoLDA0ODw');
const HOSTNAME = `${ENGINE_ID}.${ENGINE_DOMAIN}`;

const LINKED: LinkCodeStatusView = {
    status: 'linked',
    engineId: ENGINE_ID as EngineView['engineId'],
    hostname: HOSTNAME as EngineView['hostname'],
};

function engine(heartbeat: Partial<NonNullable<EngineView['heartbeat']>> = {}, overrides: Partial<EngineView> = {}) {
    const base = engineView();
    return engineView({
        status: 'owner-pending',
        reachableRelays: 1,
        heartbeat:
            base.heartbeat === null ? null : { ...base.heartbeat, members: 0, ownerHandoff: 'ready', ...heartbeat },
        ...overrides,
    });
}

const READY = engine();

function harness(entries: Readonly<Record<string, string>> = { [KEY]: SECRET }) {
    const storage = createMemorySessionStorage(entries);
    const navigations: { readonly url: string; readonly stored: string | null }[] = [];
    const deps = {
        storage,
        navigate: (url: string) => {
            navigations.push({ url, stored: storage.getItem(KEY) });
        },
    };
    return { storage, navigations, deps };
}

describe('drawOwnerSetup', () => {
    it('draws 16 bytes as a 22-character secret and commits to its SHA-256', async () => {
        const drawn = await drawOwnerSetup({ bytes: (length) => Uint8Array.from({ length }, (_, index) => index) });
        expect(drawn.secret).toBe(SECRET);
        expect(drawn.commitment).toBe(await ownerSetupCommitment(SECRET));
        expect(drawn.commitment).toHaveLength(43);
    });

    it('draws a new secret every time from the browser’s random source', async () => {
        const [a, b] = await Promise.all([drawOwnerSetup(), drawOwnerSetup()]);
        expect(a.secret).not.toBe(b.secret);
    });
});

describe('keeping the secret', () => {
    it('keeps it under the code’s ID and drops the one of the code it replaces', () => {
        const { storage } = harness({ [`ptbk.ownerSetup.${OTHER_LINK_ID}`]: SECRET });
        expect(keepOwnerSetupSecret(storage, LINK_ID, SECRET, OTHER_LINK_ID)).toBe(true);
        expect([...storage.entries]).toEqual([[KEY, SECRET]]);
        expect(holdsOwnerSetupSecret(storage, LINK_ID)).toBe(true);
        expect(holdsOwnerSetupSecret(storage, OTHER_LINK_ID)).toBe(false);
    });

    it('says when the browser refuses storage, so no commitment is sent', () => {
        const refusing: OwnerSetupStorage = {
            getItem: () => null,
            setItem: () => {
                throw new DOMException('blocked', 'SecurityError');
            },
            removeItem: () => undefined,
        };
        expect(canKeepOwnerSetupSecret(undefined)).toBe(false);
        expect(canKeepOwnerSetupSecret(refusing)).toBe(false);
        expect(keepOwnerSetupSecret(refusing, LINK_ID, SECRET, undefined)).toBe(false);
        const { storage } = harness({});
        expect(canKeepOwnerSetupSecret(storage)).toBe(true);
        expect([...storage.entries]).toEqual([]);
    });

    it('does not count a malformed stored value as a secret', () => {
        expect(holdsOwnerSetupSecret(harness({ [KEY]: 'not-a-secret' }).storage, LINK_ID)).toBe(false);
        expect(holdsOwnerSetupSecret(undefined, LINK_ID)).toBe(false);
    });
});

describe('ownerHandoffHostname', () => {
    it('is the engine’s hostname once the code is linked and the engine is live, ownerless, reachable and ready', () => {
        expect(ownerHandoffHostname(LINKED, READY)).toBe(HOSTNAME);
    });

    it('takes a direct engine’s own signal, since no relay carries it', () => {
        expect(ownerHandoffHostname(LINKED, engine({}, { mode: 'direct', reachableRelays: null }))).toBe(HOSTNAME);
    });

    it.each<[string, LinkCodeStatusView | undefined, EngineView | undefined]>([
        ['the code is not loaded', undefined, READY],
        ['the code is pending', { status: 'pending', expiresAt: 1 }, READY],
        ['the code expired', { status: 'expired' }, READY],
        ['the engine is not loaded', LINKED, undefined],
        ['the engine is another one', LINKED, engine({}, { engineId: 'x'.repeat(52) as EngineView['engineId'] })],
        ['there is no heartbeat yet', LINKED, engineView({ status: 'never-seen', heartbeat: null })],
        ['the engine has a member', LINKED, engine({ members: 1 }, { status: 'online' })],
        ['the engine sent no signal', LINKED, engine({ ownerHandoff: undefined })],
        ['the engine is offline', LINKED, engine({}, { status: 'offline' })],
        ['the engine is suspended', LINKED, engine({}, { status: 'suspended' })],
        ['no relay holds its tunnel', LINKED, engine({}, { reachableRelays: 0 })],
        ['relay presence is unknown', LINKED, engine({}, { reachableRelays: null })],
        ['the hostname is not one', LINKED, engine({}, { hostname: 'evil.test/x' as EngineView['hostname'] })],
    ])('is null when %s', (_, code, view) => {
        expect(ownerHandoffHostname(code, view)).toBeNull();
    });
});

describe('handOffOwnerSetup', () => {
    it('deletes the secret first, then opens the setup page with it in the fragment, once', () => {
        const t = harness();
        expect(handOffOwnerSetup(t.deps, LINK_ID, LINKED, READY)).toBe(true);
        expect(t.navigations).toEqual([{ url: `https://${HOSTNAME}/setup#${SECRET}`, stored: null }]);
        expect(t.storage.entries.size).toBe(0);
        expect(handOffOwnerSetup(t.deps, LINK_ID, LINKED, READY)).toBe(false);
        expect(t.navigations).toHaveLength(1);
    });

    it('does nothing in a tab without the secret, or with another code’s', () => {
        for (const entries of [{}, { [`ptbk.ownerSetup.${OTHER_LINK_ID}`]: SECRET }, { [KEY]: 'not-a-secret' }]) {
            const t = harness(entries);
            expect(handOffOwnerSetup(t.deps, LINK_ID, LINKED, READY)).toBe(false);
            expect(t.navigations).toEqual([]);
        }
        expect(handOffOwnerSetup({ storage: undefined, navigate: () => undefined }, LINK_ID, LINKED, READY)).toBe(
            false,
        );
    });

    it.each<[string, EngineView]>([
        ['before the engine is ready', engine({ ownerHandoff: undefined })],
        ['once the engine has a member', engine({ members: 1 }, { status: 'online' })],
        ['while it is not reachable', engine({}, { reachableRelays: 0 })],
        ['while it is offline', engine({}, { status: 'offline' })],
    ])('keeps the secret and stays %s', (_, view) => {
        const t = harness();
        expect(handOffOwnerSetup(t.deps, LINK_ID, LINKED, view)).toBe(false);
        expect(t.navigations).toEqual([]);
        expect(t.storage.getItem(KEY)).toBe(SECRET);
    });

    it('does not navigate when the secret cannot be deleted', () => {
        const t = harness();
        const storage: OwnerSetupStorage = {
            getItem: (key) => t.storage.getItem(key),
            setItem: () => undefined,
            removeItem: () => {
                throw new DOMException('blocked', 'SecurityError');
            },
        };
        expect(handOffOwnerSetup({ ...t.deps, storage }, LINK_ID, LINKED, READY)).toBe(false);
        expect(t.navigations).toEqual([]);
    });
});
