import { ed25519SignatureFromBytes, Hostname, type EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { createManualTimer, type ManualTimer } from '../../testing/manual-timer';
import { createMemoryEngineHostnameStore, type MemoryEngineHostnameStore } from '../../testing/memory-registry-stores';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { orgIdSchema } from '../ids';
import type { LogFields, Logger } from '../ports/logger';
import type { EngineRecord } from '../registration/engine-store';
import type { EngineStatusSnapshot } from '../status/engine-status';
import {
    readEngineOverview,
    readEngineOverviews,
    STATUS_READ_CONCURRENCY,
    type EngineOverviewDeps,
} from './engine-overview';

const ORG = orgIdSchema.parse('aaaaaaaaaaaaaaaaaaaaaaaaaa');
const NEVER_SEEN: EngineStatusSnapshot = { state: 'never-seen' };

type Behaviour = 'answer' | 'stall' | 'fail';

interface LogEntry {
    readonly level: 'info' | 'warn' | 'error';
    readonly event: string;
    readonly fields: LogFields;
}

function recordingLogger(entries: LogEntry[]): Logger {
    const at =
        (level: LogEntry['level']) =>
        (event: string, fields: LogFields = {}) => {
            entries.push({ level, event, fields });
        };
    return { info: at('info'), warn: at('warn'), error: at('error') };
}

async function engines(count: number): Promise<EngineRecord[]> {
    return Promise.all(Array.from({ length: count }, async () => engineRecord(await createTestEngine(), ORG)));
}

describe('engine overviews', () => {
    let timer: ManualTimer;
    let logged: LogEntry[];
    let hostnames: MemoryEngineHostnameStore;
    let behaviour: Map<EngineId, Behaviour>;
    let asked: EngineId[];
    let inFlight: number;
    let peak: number;
    let release: (() => void)[];
    let deps: EngineOverviewDeps;

    beforeEach(() => {
        timer = createManualTimer();
        logged = [];
        hostnames = createMemoryEngineHostnameStore();
        behaviour = new Map();
        asked = [];
        inFlight = 0;
        peak = 0;
        release = [];
        deps = {
            timer,
            logger: recordingLogger(logged),
            engineHostnames: hostnames,
            engineStatus: {
                getStatus(engineId) {
                    asked.push(engineId);
                    switch (behaviour.get(engineId) ?? 'answer') {
                        case 'stall':
                            return new Promise(() => undefined);
                        case 'fail':
                            return Promise.reject(new Error('object unavailable'));
                        case 'answer':
                            inFlight++;
                            peak = Math.max(peak, inFlight);
                            return new Promise((resolve) => {
                                release.push(() => {
                                    inFlight--;
                                    resolve(NEVER_SEEN);
                                });
                            });
                    }
                },
            },
        };
    });

    async function settleAll(): Promise<void> {
        for (let round = 0; round < 50; round++) {
            await Promise.resolve();
            release.splice(0).forEach((done) => {
                done();
            });
        }
    }

    it('asks at most ten status objects at once, and keeps the order', async () => {
        const list = await engines(25);
        const reading = readEngineOverviews(deps, list);
        await Promise.resolve();
        expect(inFlight).toBe(STATUS_READ_CONCURRENCY);
        await settleAll();
        const overviews = await reading;
        expect(peak).toBe(STATUS_READ_CONCURRENCY);
        expect(overviews.map((overview) => overview.engine.engineId)).toEqual(list.map((engine) => engine.engineId));
        expect(overviews.every((overview) => overview.status === 'never-seen')).toBe(true);
        expect(timer.pending()).toBe(0);
    });

    it('shows unknown for an engine whose status object does not answer in time, and the rest normally', async () => {
        const [slow, fast] = await engines(2);
        if (slow === undefined || fast === undefined) throw new Error('two engines');
        behaviour.set(slow.engineId, 'stall');
        const reading = readEngineOverviews(deps, [slow, fast]);
        await settleAll();
        expect(timer.pending()).toBe(1);
        timer.elapse();
        const [slowOverview, fastOverview] = await reading;
        expect(slowOverview).toMatchObject({ status: 'unknown', snapshot: null });
        expect(fastOverview).toMatchObject({ status: 'never-seen', snapshot: NEVER_SEEN });
        expect(logged).toEqual([
            { level: 'warn', event: 'engines.status-timeout', fields: { engineId: slow.engineId } },
        ]);
    });

    it('shows unknown when the status object fails, and logs only the engine ID', async () => {
        const [engine] = await engines(1);
        if (engine === undefined) throw new Error('one engine');
        behaviour.set(engine.engineId, 'fail');
        const overview = await readEngineOverview(deps, engine);
        expect(overview).toMatchObject({ status: 'unknown', snapshot: null });
        expect(logged).toEqual([
            { level: 'error', event: 'engines.status-failed', fields: { engineId: engine.engineId } },
        ]);
        expect(timer.pending()).toBe(0);
    });

    it('lists the active custom hostnames and shows a suspension over the heartbeat state', async () => {
        const [engine] = await engines(1);
        if (engine === undefined) throw new Error('one engine');
        const sig = ed25519SignatureFromBytes(new Uint8Array(64));
        hostnames.set(engine.engineId, [
            { hostname: Hostname.parse('agents.customer.test'), sig },
            { hostname: Hostname.parse('b.customer.test'), sig },
        ]);
        const reading = readEngineOverview(deps, { ...engine, status: 'suspended', statusReason: 'owner-revoked' });
        await settleAll();
        expect(await reading).toMatchObject({
            status: 'suspended',
            snapshot: NEVER_SEEN,
            customHostnames: ['agents.customer.test', 'b.customer.test'],
        });
        expect(asked).toEqual([engine.engineId]);
    });
});
