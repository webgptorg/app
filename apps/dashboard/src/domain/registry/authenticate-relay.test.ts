import { describe, expect, it } from 'vitest';

import { createRegistryTestDeps, REGISTRY_START_MS } from '../../testing/test-registry';
import { newRelayToken, sha256Hex } from '../auth/secrets';
import { newRelayTokenId } from '../ids';
import { authenticateRelay, LAST_USED_RESOLUTION_MS } from './authenticate-relay';
import type { LiveRelayToken, RelayTokenStore } from './relay-token-store';

const NOW = REGISTRY_START_MS;

function setup(options: { readonly lastUsedAt?: number | null; readonly markUsedFails?: boolean } = {}) {
    const { clock, logger, random: cryptoRandom } = createRegistryTestDeps();
    const token = newRelayToken(cryptoRandom);
    const row: LiveRelayToken = {
        id: newRelayTokenId(cryptoRandom),
        relayId: 'relay-1.ptbk.test',
        lastUsedAt: options.lastUsedAt ?? null,
    };
    const lookups: string[] = [];
    const marked: number[] = [];
    const relayTokens: RelayTokenStore = {
        async findLive(tokenHash) {
            lookups.push(tokenHash);
            return tokenHash === (await sha256Hex(token)) ? row : null;
        },
        markUsed(_, now) {
            marked.push(now);
            return options.markUsedFails === true ? Promise.reject(new Error('D1 down')) : Promise.resolve();
        },
    };
    const deferred: Promise<unknown>[] = [];
    const deps = { relayTokens, clock, logger };
    const authenticate = (header: string | null) =>
        authenticateRelay(deps, header, (task) => {
            deferred.push(task);
        });
    return { token, row, lookups, marked, logger, deferred, authenticate, random: cryptoRandom };
}

describe('authenticateRelay', () => {
    it('authenticates a live token by its hash and records the use after the response', async () => {
        const { token, row, lookups, marked, deferred, authenticate } = setup();
        expect(await authenticate(`Bearer ${token}`)).toEqual({ tokenId: row.id, relayId: row.relayId });
        expect(lookups).toEqual([await sha256Hex(token)]);
        await Promise.all(deferred);
        expect(marked).toEqual([NOW]);
    });

    it('takes the scheme in any case', async () => {
        const { token, authenticate } = setup();
        expect(await authenticate(`bearer ${token}`)).not.toBeNull();
    });

    it('refuses a missing or malformed header without a lookup', async () => {
        const { token, lookups, logger, authenticate } = setup();
        for (const header of [null, '', token, `Basic ${token}`, `Bearer ${token}x`, `Bearer ptbk_rt_short`]) {
            expect(await authenticate(header)).toBeNull();
        }
        expect(lookups).toEqual([]);
        expect(logger.entries.map((entry) => entry.fields)).toEqual([
            { reason: 'missing' },
            ...Array.from({ length: 5 }, () => ({ reason: 'malformed' })),
        ]);
        expect(JSON.stringify(logger.entries)).not.toContain(token);
    });

    it('refuses a well-formed token with no live row', async () => {
        const { lookups, logger, authenticate, random } = setup();
        expect(await authenticate(`Bearer ${newRelayToken(random)}`)).toBeNull();
        expect(lookups).toHaveLength(1);
        expect(logger.entries.at(-1)).toEqual({
            level: 'warn',
            event: 'relay.unauthorized',
            fields: { reason: 'unknown' },
        });
    });

    it('writes last use at most once per resolution window', async () => {
        const recent = setup({ lastUsedAt: NOW - LAST_USED_RESOLUTION_MS + 1 });
        await recent.authenticate(`Bearer ${recent.token}`);
        expect(recent.deferred).toEqual([]);
        const due = setup({ lastUsedAt: NOW - LAST_USED_RESOLUTION_MS });
        await due.authenticate(`Bearer ${due.token}`);
        await Promise.all(due.deferred);
        expect(due.marked).toEqual([NOW]);
    });

    it('logs a failed last-use write with the row and relay only', async () => {
        const { token, row, deferred, logger, authenticate } = setup({ markUsedFails: true });
        expect(await authenticate(`Bearer ${token}`)).not.toBeNull();
        await Promise.all(deferred);
        expect(logger.entries).toContainEqual({
            level: 'error',
            event: 'relay.mark-used-failed',
            fields: { tokenId: row.id, relayId: row.relayId },
        });
    });
});
