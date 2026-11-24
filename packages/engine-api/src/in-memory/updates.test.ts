import { describe, expect, it } from 'vitest';

import { KNOWN_CAPABILITIES } from '../capabilities/capability';
import { MAX_UI_CHECK_INTERVAL_MS, UPDATE_CHECK_MIN_INTERVAL_MS } from '../capabilities/updates';
import { createEngineApiClient } from '../client';
import type { EngineApiResponse } from '../client';
import { Timestamp } from '../common';
import type { EngineEvent } from '../events';
import { DEFAULT_CAPABILITIES, actorFromOptions, createInMemoryEngineCore } from '../in-memory-client';
import type { InMemoryEngineCoreOptions } from '../in-memory-client';
import { OWNER_PERMISSIONS } from '../permissions';
import { withClientReading } from '../reader';
import { UiUpdateCheck } from '../security';
import { compareVersions } from './updates';
import type { UiUpdater } from './updates';

const START = Date.parse('2026-11-24T08:00:00Z');
const signal = () => AbortSignal.timeout(5_000);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got problem ${response.problem.code}`);
    return response.data;
}

function codeOf(response: EngineApiResponse<unknown>): string {
    if (response.kind !== 'problem') throw new Error('Expected a problem');
    return response.problem.code;
}

function setup(options: Partial<InMemoryEngineCoreOptions> & { readonly policy?: 'auto' | 'manual' | 'pinned' } = {}) {
    let nowMs = START;
    const { policy = 'auto', ...rest } = options;
    const core = createInMemoryEngineCore({
        clock: { now: () => new Date(nowMs) },
        seed: {
            settings: {
                name: 'Engine',
                defaultAgentVisibility: 'private',
                updatePolicy: { policy, pinnedVersion: policy === 'pinned' ? '1.2.0' : null },
            },
        },
        ...rest,
    });
    const clientAs = (permissions = OWNER_PERMISSIONS) =>
        createEngineApiClient(withClientReading(core.transport(actorFromOptions({ member: { permissions } }))));
    const events: EngineEvent[] = [];
    core.controller.onEvent((event) => events.push(event));
    return {
        core,
        client: clientAs(),
        clientAs,
        events,
        advance: (ms: number) => {
            nowMs += ms;
        },
    };
}

describe('updates@1 in the in-memory engine', () => {
    it('reports the next check an hour after the last one, and none under manual', async () => {
        const { client, core } = setup();
        const lastAt = Date.parse(ok(await client.security.get(signal())).ui.lastUpdateCheck?.at ?? '');
        expect(ok(await client.security.get(signal())).ui.nextCheckAt).toBe(iso(lastAt + MAX_UI_CHECK_INTERVAL_MS));
        await core.controller.runUiUpdateCheck();
        expect(ok(await client.security.get(signal())).ui.nextCheckAt).toBe(iso(START + MAX_UI_CHECK_INTERVAL_MS));
        const manual = setup({ policy: 'manual' });
        expect(ok(await manual.client.security.get(signal())).ui.nextCheckAt).toBeNull();
    });

    it('leaves nextCheckAt null on an engine without the capability', async () => {
        const without = DEFAULT_CAPABILITIES.filter((ref) => ref !== KNOWN_CAPABILITIES.updates);
        const { client } = setup({ capabilities: without });
        expect(ok(await client.security.get(signal())).ui.nextCheckAt).toBeNull();
        expect(codeOf(await client.updates.checkUi(signal()))).toBe('capability-not-supported');
    });

    it('runs the normal check: up to date when the store has nothing newer, announced and audited', async () => {
        const { client, core, events } = setup();
        const check = ok(await client.updates.checkUi(signal()));
        expect(check).toMatchObject({
            at: new Date(START).toISOString(),
            outcome: 'up-to-date',
            version: '1.0.0',
            reason: null,
        });
        expect(ok(await client.security.get(signal())).ui.lastUpdateCheck).toEqual(check);
        expect(events).toContainEqual({ type: 'updates.changed', uiVersion: '1.0.0' });
        await Promise.resolve();
        expect(core.controller.inspect().counts.auditEntries).toBeGreaterThan(0);
        const entries = ok(await client.audit.list({ action: 'updates.ui-check' }, signal()));
        expect(entries.items).toHaveLength(1);
    });

    it('refuses a release inside its delay with eligibleAt, and the next check is due then', async () => {
        const { client, core, advance } = setup();
        const eligibleAt = iso(START + 10 * 60_000);
        core.controller.setUiRelease({ version: '1.1.0', eligibleAt });
        const check = ok(await client.updates.checkUi(signal()));
        expect(check).toMatchObject({ outcome: 'refused', reason: 'delay-not-elapsed', version: '1.1.0', eligibleAt });
        const security = ok(await client.security.get(signal()));
        expect(security.ui.version).toBe('1.0.0');
        expect(security.ui.nextCheckAt).toBe(eligibleAt);
        advance(10 * 60_000);
        const installed = await core.controller.runUiUpdateCheck();
        expect(installed).toMatchObject({ outcome: 'installed', version: '1.1.0' });
        expect(ok(await client.security.get(signal())).ui).toMatchObject({ version: '1.1.0', releaseLogIndex: null });
    });

    it('limits check-now to one a minute per engine, whoever asks; scheduled checks do not count', async () => {
        const { client, clientAs, core, advance } = setup();
        await core.controller.runUiUpdateCheck();
        ok(await client.updates.checkUi(signal()));
        advance(UPDATE_CHECK_MIN_INTERVAL_MS - 1_000);
        expect(codeOf(await clientAs().updates.checkUi(signal()))).toBe('update-check-too-soon');
        advance(1_000);
        ok(await client.updates.checkUi(signal()));
    });

    it('refuses under manual, where nothing is scheduled to run early', async () => {
        const { client, core } = setup({ policy: 'manual' });
        core.controller.setUiRelease({ version: '1.1.0' });
        expect(codeOf(await client.updates.checkUi(signal()))).toBe('update-policy-manual');
        expect(ok(await client.security.get(signal())).ui.version).toBe('1.0.0');
        // The owner's approval on the host skips the delay and nothing else.
        expect(await core.controller.runUiUpdateCheck()).toMatchObject({ outcome: 'installed', version: '1.1.0' });
    });

    it('needs settings.manage', async () => {
        const { clientAs } = setup();
        const reader = clientAs(OWNER_PERMISSIONS.filter((permission) => permission !== 'settings.manage'));
        expect(codeOf(await reader.updates.checkUi(signal()))).toBe('forbidden');
    });

    it('installs a pinned release without waiting, and reports a store that is down or lacks it', async () => {
        const { client, core, advance } = setup({ policy: 'pinned' });
        expect(ok(await client.updates.checkUi(signal()))).toMatchObject({ outcome: 'unavailable', version: null });
        core.controller.setUiRelease({ version: '1.2.0', eligibleAt: iso(START + 3_600_000) });
        core.controller.failUiReleaseStore(true);
        expect(await core.controller.runUiUpdateCheck()).toMatchObject({ outcome: 'unavailable' });
        core.controller.failUiReleaseStore(false);
        advance(UPDATE_CHECK_MIN_INTERVAL_MS);
        expect(ok(await client.updates.checkUi(signal()))).toMatchObject({ outcome: 'installed', version: '1.2.0' });
    });

    it('never goes back: an older pinned version is refused as not newer', async () => {
        const { core } = setup({ policy: 'pinned' });
        core.controller.updateSecurity({
            ui: { ...core.controller.updateSecurity({}).ui, version: '2.0.0' },
        });
        expect(await core.controller.runUiUpdateCheck()).toMatchObject({ outcome: 'refused', reason: 'not-newer' });
        core.controller.setUiRelease(null);
    });

    it('delegates to a plugged-in updater for policy, schedule and the check', async () => {
        const check = UiUpdateCheck.parse({
            at: iso(START),
            outcome: 'refused',
            version: '3.0.0',
            reason: 'delay-not-elapsed',
            revocationReason: null,
            eligibleAt: iso(START + 60_000),
        });
        let policy: 'auto' | 'manual' = 'auto';
        const updater: UiUpdater = {
            policy: () => policy,
            nextCheckAt: () => Timestamp.parse(iso(START + 60_000)),
            checkNow: () => Promise.resolve(check),
        };
        const { client, core } = setup({ uiUpdater: updater });
        expect(ok(await client.updates.checkUi(signal()))).toEqual(check);
        expect(await core.controller.runUiUpdateCheck()).toEqual(check);
        expect(ok(await client.security.get(signal())).ui.nextCheckAt).toBe(iso(START + 60_000));
        policy = 'manual';
        expect(codeOf(await client.updates.checkUi(signal()))).toBe('update-policy-manual');
    });

    it('refuses levers that are not a version or a time', () => {
        const { core } = setup();
        expect(() => {
            core.controller.setUiRelease({ version: 'one' });
        }).toThrow();
        expect(() => {
            core.controller.setUiRelease({ version: '1.1.0', eligibleAt: 'tomorrow' });
        }).toThrow();
    });

    it('orders versions by their numbers', () => {
        expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
        expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(0);
        expect(compareVersions('0.2.4', '0.2.5')).toBe(-1);
    });
});
