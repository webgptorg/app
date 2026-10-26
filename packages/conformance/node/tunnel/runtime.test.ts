import { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { startFakeRelay } from '../fake-relay/fake-relay';
import { createTestCa } from '../pki/test-ca';
import { delay } from './checks/support';
import { CONTRACT_TIMING, TunnelRuntime } from './runtime';
import { relayIdsFor } from './tunnel-relay';

const ENGINE_DOMAIN = Hostname.parse('engine.localhost');

describe('TunnelRuntime', () => {
    it('needs a relay and an attached engine', async () => {
        const relay = await startFakeRelay({ relayIds: [], trustedCa: createTestCa('runtime test CA') });
        try {
            const runtime = new TunnelRuntime(relay, ENGINE_DOMAIN, CONTRACT_TIMING);
            expect(() => runtime.primary).toThrow('no relay');
            expect(() => runtime.engine).toThrow('no engine attached');
            const [unknown] = relayIdsFor(1);
            if (unknown === undefined) throw new Error('no relay ID');
            expect(runtime.openTunnels(unknown)).toEqual([]);
        } finally {
            await relay.close();
        }
    });

    it('stops waiting when the signal aborts, with or without an error as the reason', async () => {
        const relay = await startFakeRelay({ relayIds: relayIdsFor(1), trustedCa: createTestCa('runtime test CA') });
        try {
            const runtime = new TunnelRuntime(relay, ENGINE_DOMAIN, CONTRACT_TIMING);
            const plain = new AbortController();
            const waiting = runtime.waitReady(runtime.primary, 10_000, plain.signal);
            plain.abort('stop');
            await expect(waiting).rejects.toThrow('aborted');
            const withError = new AbortController();
            const sleeping = delay(10_000, withError.signal);
            withError.abort(new Error('stop'));
            await expect(sleeping).rejects.toThrow('stop');
            const plainDelay = new AbortController();
            const sleepingPlain = delay(10_000, plainDelay.signal);
            plainDelay.abort('stop');
            await expect(sleepingPlain).rejects.toThrow('aborted');
        } finally {
            await relay.close();
        }
    });
});
